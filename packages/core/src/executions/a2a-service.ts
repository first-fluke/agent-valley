import { randomUUID } from "node:crypto"
import { z } from "zod"
import { ActiveMissionProcess } from "../chief/active-process"
import { finishLocalProcess } from "../chief/local-runner"
import type { RunAttempt } from "../domain/models"
import { AgentRunError } from "../domain/ports/agent-runner"
import { logger } from "../observability/logger"
import { runVerificationGate } from "../orchestrator/verification-gate"
import { A2aAgentRunnerAdapter } from "../sessions/adapters/a2a-agent-runner"
import {
  type A2aEndpoint,
  type A2aSendResponse,
  a2aRequestSha256,
  isA2aTerminal,
} from "../sessions/adapters/a2a-contracts"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import { applyA2aArtifacts, validateA2aAllowedPaths } from "./a2a-artifact"
import { type A2aJob, a2aEndpointSchema, a2aJobInput, a2aJobSchema } from "./a2a-job"
import { a2aRepository, assertA2aClean } from "./a2a-repository"
import { A2aJobStore } from "./a2a-store"

export interface StartA2aOptions {
  root: string
  goal: string
  endpoint: A2aEndpoint
  allowedPaths: string[]
  verifyCommand: string
  timeoutSec?: number
}

const terminalStatuses = new Set(["completed", "failed", "reconciled"])

export async function startA2aExecution(
  options: StartA2aOptions,
  signal?: AbortSignal,
  onCreated?: (job: A2aJob) => void,
): Promise<A2aJob> {
  signal?.throwIfAborted()
  const repository = await a2aRepository(options.root)
  const store = new A2aJobStore(repository.root)
  const release = await store.lock()
  try {
    const pending = (await store.list()).find((job) => !terminalStatuses.has(job.status))
    if (pending)
      throw new Error(
        `A2A execution ${pending.id} is unresolved. Use av a2a resume or reconcile before starting another.`,
      )
    const baseFingerprint = await assertA2aClean(repository.root)
    const allowedPaths = validateA2aAllowedPaths(options.allowedPaths)
    const id = randomUUID()
    const createdAt = new Date().toISOString()
    const endpoint = a2aEndpointSchema.parse(options.endpoint)
    const prompt = artifactPrompt(options.goal, { id, ...repository, allowedPaths })
    const job = a2aJobSchema.parse({
      version: 1,
      ...repository,
      baseFingerprint,
      id,
      endpoint,
      goal: options.goal,
      prompt,
      requestSha256: "0".repeat(64),
      allowedPaths,
      verifyCommand: options.verifyCommand,
      timeoutSec: options.timeoutSec ?? 600,
      createdAt,
      updatedAt: createdAt,
      status: "pending",
    })
    job.requestSha256 = a2aRequestSha256(a2aJobInput(job), endpoint)
    await store.save(job)
    onCreated?.(job)
    return await execute(store, job, signal)
  } finally {
    await release()
  }
}

export async function resumeA2aExecution(root: string, id: string, signal?: AbortSignal): Promise<A2aJob> {
  const repository = await a2aRepository(root)
  const store = new A2aJobStore(repository.root)
  const release = await store.lock()
  try {
    const job = await store.load(id)
    if (job.repositoryId !== repository.repositoryId)
      throw new Error("A2A repository identity changed. Restore the original repository before resuming.")
    if (job.status === "completed" || job.status === "reconciled" || (job.status === "failed" && job.result)) return job
    return await execute(store, job, signal)
  } finally {
    await release()
  }
}

export async function listA2aExecutions(root: string): Promise<A2aJob[]> {
  const repository = await a2aRepository(root)
  return new A2aJobStore(repository.root).list()
}

export async function reconcileA2aExecution(root: string, id: string, evidence: string): Promise<A2aJob> {
  const proof = z.string().trim().min(1).max(2_000).parse(evidence)
  const repository = await a2aRepository(root)
  const store = new A2aJobStore(repository.root)
  const release = await store.lock()
  try {
    const job = await store.load(id)
    if (job.repositoryId !== repository.repositoryId || !["unknown", "running"].includes(job.status))
      throw new Error("Select an uncertain A2A execution in its original repository and record proof that it stopped.")
    await new ActiveMissionProcess(store.directory, job.id).recoverOrphan()
    job.status = "reconciled"
    job.reconciliation = { evidence: proof, at: new Date().toISOString() }
    job.updatedAt = job.reconciliation.at
    await store.save(job)
    logger.info("a2a", "Execution termination reconciled by operator", { executionId: job.id })
    return job
  } finally {
    await release()
  }
}

async function execute(store: A2aJobStore, job: A2aJob, signal?: AbortSignal): Promise<A2aJob> {
  const input = a2aJobInput(job, signal)
  if (a2aRequestSha256(input, job.endpoint) !== job.requestSha256)
    throw new Error("A2A saved request binding changed. Restore the original execution record; do not resubmit it.")
  const guard = new ActiveMissionProcess(store.directory, job.id)
  await guard.recoverOrphan()
  const persist = async () => {
    job.updatedAt = new Date().toISOString()
    await store.save(job)
  }
  const complete = async (response: A2aSendResponse): Promise<RunAttempt> => {
    signal?.throwIfAborted()
    job.response = response
    await persist()
    if (response.task && response.task.status.state !== "TASK_STATE_COMPLETED") {
      if (!isA2aTerminal(response.task.status.state))
        throw new Error("A2A completion requires an observed terminal task.")
      return {
        ...(input.attempt as RunAttempt),
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        agentOutput: `Remote task ended with ${response.task.status.state}.`,
      }
    }
    const binding = {
      attemptId: job.id,
      requestSha256: job.requestSha256,
      repositoryId: job.repositoryId,
      baseRevision: job.baseRevision,
      baseFingerprint: job.baseFingerprint,
      allowedPaths: job.allowedPaths,
    }
    const hooks = {
      load: async () => job.artifact,
      save: async (journal: NonNullable<A2aJob["artifact"]>) => {
        job.artifact = journal
        await persist()
      },
    }
    signal?.throwIfAborted()
    const artifact = await applyA2aArtifacts(job.root, binding, response, hooks, signal)
    signal?.throwIfAborted()
    job.status = "verifying"
    await persist()
    try {
      guard.begin("a2a-verify")
    } catch {
      throw new AgentRunError(
        "A2A verifier process ownership is uncertain. Inspect the saved process guard before resuming.",
        input.attempt as RunAttempt,
        { outcomeUnknown: true },
      )
    }
    let verification: Awaited<ReturnType<typeof runVerificationGate>> | undefined
    let verificationFailure: unknown
    try {
      verification = await runVerificationGate(input.workspace, job.verifyCommand, {
        timeoutSec: job.timeoutSec,
        signal,
        onSpawned: (pid) => guard.spawned(pid, process.platform !== "win32"),
      })
    } catch (error) {
      verificationFailure = error
    }
    try {
      await finishLocalProcess(guard)
    } catch {
      throw new AgentRunError(
        "A2A verification process cleanup is unconfirmed. Reconcile the saved process guard before allowing another writer.",
        input.attempt as RunAttempt,
        { outcomeUnknown: true },
      )
    }
    if (verificationFailure) throw verificationFailure
    if (!verification) throw new Error("A2A verification produced no result. Inspect the saved verifier record.")
    const fingerprint = await fingerprintWorkspace(job.root)
    let intact = false
    try {
      // Recheck HEAD and every delivered file as well as the product fingerprint;
      // ignored allowed files and a verifier-created commit also need evidence.
      await applyA2aArtifacts(job.root, binding, response, hooks, signal)
      intact = true
    } catch {
      /* Keep the failed verification receipt; never adopt a changed delivery. */
    }
    job.verification = {
      ok: verification.ok && intact && fingerprint === artifact.fingerprint,
      command: job.verifyCommand,
      output: verification.output ?? "",
      fingerprint,
      at: new Date().toISOString(),
    }
    await persist()
    if (!job.verification.ok)
      throw new AgentRunError(
        "A2A artifacts failed trusted verification or changed during verification. Inspect av a2a status; resume rechecks the saved response without resubmitting.",
        {
          ...(input.attempt as RunAttempt),
          finishedAt: new Date().toISOString(),
          exitCode: 1,
          agentOutput: verification.output ?? null,
        },
      )
    return {
      ...(input.attempt as RunAttempt),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      agentOutput: `Validated ${artifact.paths.length} file(s); trusted verification passed at ${fingerprint}.`,
    }
  }
  try {
    signal?.throwIfAborted()
    job.status = "running"
    await persist()
    let result: RunAttempt
    if (job.response) result = await complete(job.response)
    else {
      const runner = new A2aAgentRunnerAdapter(job.endpoint, () => ({
        load: async () => job.checkpoint,
        save: async (checkpoint) => {
          job.checkpoint = checkpoint
          await persist()
        },
        complete: async (response) => complete(response),
      }))
      result = await (await runner.spawn(input)).result
    }
    if (result.id !== job.id || result.issueId !== job.id || result.workspacePath !== job.root || !result.finishedAt)
      throw new Error("A2A result identity is invalid. Inspect the saved execution record before resuming.")
    job.result = {
      id: result.id,
      issueId: result.issueId,
      workspacePath: result.workspacePath,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      exitCode: result.exitCode ?? 1,
      agentOutput: result.agentOutput,
    }
    job.status = result.exitCode === 0 ? "completed" : "failed"
    delete job.error
    await persist()
    logger.info("a2a", "Execution observed", {
      executionId: job.id,
      status: job.status,
      taskId: job.checkpoint?.taskId,
    })
    return job
  } catch (error) {
    const knownTerminal = Boolean(job.response) || Boolean(job.checkpoint?.state && isA2aTerminal(job.checkpoint.state))
    job.status =
      (error instanceof AgentRunError && error.outcomeUnknown) ||
      (!knownTerminal && job.checkpoint && job.checkpoint.phase !== "prepared")
        ? "unknown"
        : "failed"
    job.error = (error instanceof Error ? error.message : "A2A execution failed. Inspect the saved record.").slice(
      0,
      4_000,
    )
    await persist()
    throw new Error(`${job.error} Execution ${job.id} is ${job.status}; inspect av a2a status ${job.id}.`)
  }
}

function artifactPrompt(
  goal: string,
  binding: { id: string; repositoryId: string; baseRevision: string; allowedPaths: string[] },
): string {
  return `${goal}\n\nReturn code changes as exactly one inline A2A data Part with this envelope:\n${JSON.stringify({
    agentValleyArtifact: {
      version: 1,
      attemptId: binding.id,
      requestSha256: "echo message.metadata.agentValley.requestSha256",
      repositoryId: binding.repositoryId,
      baseRevision: binding.baseRevision,
      files: [
        {
          path: "one exact allowed path",
          contentBase64: "canonical base64 of complete file bytes",
          sha256: "SHA256 of decoded bytes",
          executable: false,
        },
      ],
    },
  })}\nAllowed paths: ${JSON.stringify(binding.allowedPaths)}. To delete a file use contentBase64:null and sha256:null. Do not return URLs, symlinks, patches, credentials, or verification claims as delivery evidence. AV checks the bytes against this request and base revision and runs its fixed local verifier. The endpoint must already have authorized access to the intended repository revision; AV does not upload repository files or credentials.`
}
