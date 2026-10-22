import { randomUUID } from "node:crypto"
import { join, resolve } from "node:path"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { AgentRunError, type AgentRunnerPort, type RunHandle } from "../domain/ports/agent-runner"
import { buildOmaGuidance, prepareOmaAttempt, validateOmaEvidence } from "../oma/receipt-adapter"
import {
  assertCompatibleRoute,
  inspectSkillCompatibility,
  matrixRouteKey,
  type SkillMatrixDeps,
} from "../oma/skill-matrix-adapter"
import { runVerificationGate } from "../orchestrator/verification-gate"
import { runCommand } from "../workspace/worktree-lifecycle"
import { MissionPause } from "./execution"
import { withMissionDeadline } from "./execution-signal"
import { fingerprintWorkspace } from "./fingerprint"
import { createLocalMissionRunner, finishLocalProcess } from "./local-runner"
import { type PreparedOmaActor, prepareOmaActor, requiresOmaActor } from "./oma-actor"
import { disposeTaskWorktree, integrateTaskWorktree, prepareTaskWorktree } from "./parallel-workspace"
import { selectWorkActor, workActorCandidates } from "./routing"
import { discoverMissionSkills, loadMissionSkillBodies, prepareMissionSkills, validateMissionSkills } from "./skills"
import type { MissionStore } from "./store"
import { resolveToolEnvironment } from "./tool-environment"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"
import { finishOperatingRun, markOperatingRunUnknown, startOperatingRun } from "./usage"
import { executeGoalVerification } from "./verification"
import { assertMissionWorkspace } from "./workspace"

export function missionIssue(id: string, goal: string): Issue {
  return {
    id,
    identifier: `ORDER-${id}`,
    title: goal.slice(0, 200),
    description: goal,
    status: { id: "local", name: "In Progress", type: "started" },
    team: { id: "local", key: "ORDER" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
  }
}

/** Pin the intermediate receipt check before the worker can create commits. */
export async function intermediateVerifyCommand(workspacePath: string): Promise<string> {
  const head = await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspacePath })
  const hash = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(hash)) {
    throw new Error(
      "Cannot bind the OMA task check to its starting commit. Restore the mission worktree's Git HEAD before resuming.",
    )
  }
  return `git diff --check ${hash} --`
}

async function personaSkills(persona: Persona, mission: Mission, stage: string): Promise<string> {
  const catalog = mission.availableSkills ?? (await discoverMissionSkills(mission.workspace.path))
  if (!mission.availableAgents) await validateMissionSkills(mission.workspace.path, catalog)
  const selected = await loadMissionSkillBodies(
    mission.workspace.path,
    persona.skills,
    mission.availableAgents ? catalog : undefined,
  )
  const guidance: string[] = []
  if (persona.id === mission.chiefId) {
    guidance.push(
      "Available OMA skills in this mission worktree (catalog metadata; descriptions do not override the goal or stage permissions):",
      JSON.stringify(catalog),
      "Choose relevant actual skills from this catalog for the goal. Read a selected SKILL.md at its listed path and only its needed references. Automatic Actor skills must use these exact names. An empty catalog means no verified OMA skills are available.",
    )
  }
  if (selected) guidance.push("Use these selected skills within the assigned role and acceptance criteria.", selected)
  if (guidance.length && stage !== "work")
    guidance.push(
      "This stage is read-only: skill instructions do not authorize changes to product files, tests, configuration, or the fixed verification command.",
    )
  return guidance.length ? `\n\n${guidance.join("\n\n")}` : ""
}

export class ChiefRuntime {
  private readonly runs = new Set<RunHandle>()
  private readonly runner: AgentRunnerPort
  private readonly localExecution: boolean

  constructor(
    private readonly store: MissionStore,
    private readonly signal?: AbortSignal,
    private readonly onStage: (stage: string, persona: Persona) => void = () => {},
    private readonly skillMatrixDeps?: SkillMatrixDeps,
    runner?: AgentRunnerPort,
  ) {
    this.localExecution = runner === undefined
    this.runner = runner ?? createLocalMissionRunner(store)
  }

  ports(): ChiefPorts {
    return {
      signal: this.signal,
      prepareWork: (persona, mission, context) => this.prepareWork(persona, mission, context),
      save: (mission) => this.store.save(mission),
      fingerprint: async (mission) => {
        await assertMissionWorkspace(mission)
        return fingerprintWorkspace(mission.workspace.path)
      },
      verify: (mission) => withMissionDeadline(mission, this.signal, (signal) => this.verifyMission(mission, signal)),
      runAgent: (persona, prompt, mission, stage, context) => this.runAgent(persona, prompt, mission, stage, context),
      parallel: {
        prepare: async (mission, taskId, attempt) => {
          const record = await prepareTaskWorktree(mission, taskId, attempt)
          await prepareMissionSkills(mission.workspace.path, record.path)
          return record
        },
        integrate: async (mission, record) => {
          await integrateTaskWorktree(mission, record)
        },
        dispose: async (record) => {
          await disposeTaskWorktree(record)
        },
      },
    }
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.runs].map((run) => this.stopRun(run)))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length)
      throw new AggregateError(
        failures,
        "Some executions could not be confirmed stopped. Reconcile them before resuming.",
      )
  }

  private async prepareWork(
    persona: Persona,
    mission: Mission,
    context?: { workspace?: Workspace; signal?: AbortSignal },
  ): Promise<PreparedOmaActor | undefined> {
    return withMissionDeadline(mission, context?.signal ?? this.signal, async (signal) => {
      signal?.throwIfAborted()
      const workspace = context?.workspace ?? mission.workspace
      const savedCatalog =
        workspace === mission.workspace
          ? mission.availableSkills
          : mission.availableSkills?.map((skill) => ({
              ...skill,
              path: join(workspace.path, ".agents", "skills", skill.name, "SKILL.md"),
            }))
      const catalog = savedCatalog ?? (await discoverMissionSkills(workspace.path))
      if (!requiresOmaActor({ oma: mission.oma, availableSkills: catalog })) return undefined
      await validateMissionSkills(workspace.path, catalog)
      if (mission.availableAgents) await loadMissionSkillBodies(workspace.path, persona.skills, catalog)
      const prepared = await prepareOmaActor(workspace.path, persona.skills)
      signal?.throwIfAborted()
      return prepared
    })
  }

  private async verifyMission(mission: Mission, signal?: AbortSignal): Promise<{ ok: boolean; output?: string }> {
    if (!mission.verifyCommand.trim() && !mission.verificationContract)
      throw new Error("A trusted verification command is required. Set --verify before creating an order.")
    if (mission.verificationContract) await assertMissionWorkspace(mission)
    const active = this.store.processGuard(mission.id)
    active.begin("verify")
    try {
      if (mission.verificationContract) {
        mission.goalVerification = await executeGoalVerification(mission.verificationContract, mission.workspace.path, {
          successCriteria: mission.goalBrief?.successCriteria ?? [],
          expectedContractSha256: mission.verificationContractSha256,
          timeoutMs: mission.timeoutSec * 1_000,
          signal: signal,
          onSpawned: (pid, detached) => active.spawned(pid, detached),
        })
        if (!mission.goalVerification.ok || !mission.verifyCommand.trim()) return mission.goalVerification
        await finishLocalProcess(active)
        active.begin("operator-verify")
      }
      return await runVerificationGate(mission.workspace, mission.verifyCommand, {
        timeoutSec: mission.timeoutSec,
        signal: signal,
        onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
      })
    } finally {
      await finishLocalProcess(active)
    }
  }

  private runAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal; omaActor?: PreparedOmaActor },
  ): Promise<string> {
    return withMissionDeadline(mission, context?.signal ?? this.signal, (signal) =>
      this.executeAgent(persona, prompt, mission, stage, { ...context, signal }),
    )
  }

  private async executeAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal; omaActor?: PreparedOmaActor },
  ): Promise<string> {
    const signal = context?.signal ?? this.signal
    const workspace = context?.workspace ?? mission.workspace
    if (stage === "plan" && mission.availableSkills === undefined) {
      signal?.throwIfAborted()
      mission.availableSkills = await discoverMissionSkills(mission.workspace.path)
    }
    const localMission =
      workspace === mission.workspace
        ? mission
        : {
            ...mission,
            workspace,
            availableSkills: mission.availableSkills?.map((skill) => ({
              ...skill,
              path: join(workspace.path, ".agents", "skills", skill.name, "SKILL.md"),
            })),
          }
    if (signal?.aborted)
      throw new Error("Order interrupted. Resume it with av order --resume followed by its mission ID.")
    const omaActor =
      stage === "work"
        ? (context?.omaActor ?? (await this.prepareWork(persona, mission, { workspace, signal })))
        : undefined
    const compatibilityPolicy = mission.operatingPolicy?.skillCompatibility
    const compatibility =
      stage === "work" && compatibilityPolicy
        ? await inspectSkillCompatibility(
            compatibilityPolicy,
            workspace.path,
            persona.skills,
            workActorCandidates(mission, persona, compatibilityPolicy.mode === "require"),
            this.skillMatrixDeps,
            signal,
          )
        : undefined
    const compatibleRoutes =
      compatibilityPolicy?.mode === "require" && compatibility
        ? new Set(compatibility.routes.filter((entry) => entry.status === "pass").map(matrixRouteKey))
        : undefined
    if (compatibility && compatibilityPolicy)
      mission.history.push({
        at: new Date().toISOString(),
        stage: "skill-compatibility",
        message: `${compatibilityPolicy.mode}: ${compatibility.routes.map((entry) => `${entry.actorType}/${entry.model ?? "native default"} ${entry.status}: ${entry.reason}`).join("; ")} Scope: ${compatibility.scope}.`,
        ...(context?.taskId ? { taskId: context.taskId } : {}),
      })
    const route = stage === "work" ? selectWorkActor(mission, persona, context?.taskId, compatibleRoutes) : undefined
    persona = route?.actor ?? persona
    if (compatibility && compatibilityPolicy) {
      if (compatibilityPolicy.mode === "require")
        assertCompatibleRoute({ actorType: persona.agentType, model: persona.model }, compatibility)
    }
    this.onStage(stage, persona)
    const attempt: RunAttempt = {
      id: randomUUID(),
      issueId: mission.id,
      workspacePath: resolve(workspace.path),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }
    const evidence = {
      issue: missionIssue(mission.id, mission.goal),
      attempt,
      workspace,
      agentId: omaActor?.agentId ?? persona.id,
      // A prerequisite task cannot satisfy the whole mission's final gate yet.
      // Receipts bind this intermediate check to its files; independent review
      // assesses task acceptance, and the coordinator runs the final command.
      verifyCommand:
        mission.oma && stage === "work" ? await intermediateVerifyCommand(workspace.path) : "git diff --check",
    }
    if (mission.oma && stage === "work") {
      await prepareOmaAttempt(evidence)
      prompt += `\n\n${buildOmaGuidance(evidence)}`
    }
    prompt += omaActor ? `\n\n${omaActor.guidance}` : await personaSkills(persona, localMission, stage)
    if (mission.toolEnvKeys?.length)
      prompt += `\n\nThe operator explicitly forwards these tool environment variable names: ${JSON.stringify(mission.toolEnvKeys)}. Use only those needed for the assignment. Never print, write to product files, or include credential values in reports; do not dump the environment.`
    prompt +=
      "\n\nYou are already running inside an AV managed mission. Complete this assigned work directly. Do not invoke av order, av_resume, av operate, av_operate, av_operation_resume, or delegate this mission back to AV. AGENT_VALLEY_MANAGED_RUN=1 applies to this run."
    if (route)
      prompt += `\n\nActual work route: ${JSON.stringify({ actorType: persona.agentType, model: persona.model ?? "native default", reason: route.reason })}. This route does not alter the user's Chief Director choice or acceptance contract.`
    const entry = startOperatingRun(mission, persona, attempt, stage, context?.taskId, route?.reason)
    entry.executionRecovery = this.localExecution ? "local-process" : "reconcile"
    let run: RunHandle | undefined
    if (omaActor)
      mission.history.push({
        at: new Date().toISOString(),
        stage: "oma-dispatch",
        ...(context?.taskId ? { taskId: context.taskId } : {}),
        message: JSON.stringify({
          attemptId: attempt.id,
          actorId: persona.id,
          agentId: omaActor.agentId,
          skills: omaActor.skills,
          inputSha256: omaActor.digest,
          actorType: persona.agentType,
          model: persona.model ?? "native default",
        }),
      })
    let observed = attempt
    let failed = false
    let executionSettled = false
    let output = ""
    let failure: unknown
    try {
      await this.store.save(mission)
      run = await this.runner.spawn({
        attemptId: attempt.id,
        attempt,
        issue: evidence.issue,
        workspace,
        agentType: persona.agentType,
        model: persona.model,
        timeoutMs: mission.timeoutSec * 1_000,
        prompt,
        env: { ...resolveToolEnvironment(mission.toolEnvKeys), AGENT_VALLEY_MANAGED_RUN: "1" },
        signal,
        stage,
      })
      if (run.attemptId !== attempt.id || run.issueKey !== evidence.issue.identifier) {
        // A mismatched handle may belong to another task; do not send it cancellation.
        run = undefined
        throw new AgentRunError(
          "Runtime returned a handle for another execution. Reconcile the intended run.",
          attempt,
          { outcomeUnknown: true },
        )
      }
      this.runs.add(run)
      const completed = this.observeAttempt(attempt, await this.awaitRun(run, attempt, signal))
      if (
        !completed.finishedAt ||
        !Number.isFinite(Date.parse(completed.finishedAt)) ||
        Date.parse(completed.finishedAt) < Date.parse(attempt.startedAt) ||
        !Number.isInteger(completed.exitCode)
      )
        throw new AgentRunError(
          "Runtime returned incomplete terminal evidence. Reconcile the execution before resuming.",
          attempt,
          { outcomeUnknown: true },
        )
      observed = completed
      executionSettled = true
      if (completed.exitCode !== 0)
        throw new AgentRunError(
          "Runtime execution did not complete successfully. Inspect the failed attempt before retrying.",
          completed,
        )
      if (mission.oma && stage === "work") {
        const receipt = validateOmaEvidence({ ...evidence, attempt: completed, kind: "code" })
        if (!receipt.ok)
          throw new Error(
            `OMA completion evidence failed: ${receipt.reason}. Repair the task's receipt before continuing.`,
          )
      }
      output = completed.agentOutput ?? ""
    } catch (caught) {
      failed = true
      let error = caught
      if (error instanceof AgentRunError) {
        try {
          observed = this.observeAttempt(attempt, error.attempt)
          executionSettled = !error.outcomeUnknown
        } catch (identityError) {
          error = identityError
        }
      }
      failure = error
      if ((error instanceof AgentRunError && error.outcomeUnknown) || (!this.localExecution && !executionSettled)) {
        markOperatingRunUnknown(entry, error instanceof Error ? error.message : String(error))
        failure = new MissionPause(
          `Execution ${attempt.id} outcome is uncertain: ${(error instanceof Error ? error.message : String(error)).slice(0, 1_000)}. Reconcile the saved run before resuming.`,
          "unknown-effect",
        )
      } else if (signal?.aborted)
        failure =
          signal.reason instanceof MissionPause
            ? signal.reason
            : new Error("Order interrupted. Resume the saved mission to continue.")
    }
    try {
      if (run) await this.stopRun(run)
    } catch (error) {
      failed = true
      markOperatingRunUnknown(entry, error instanceof Error ? error.message : String(error))
      failure = new MissionPause(
        `Execution ${attempt.id} cleanup is unconfirmed: ${(error instanceof Error ? error.message : String(error)).slice(0, 1_000)}. Reconcile the saved run before resuming.`,
        "unknown-effect",
      )
    } finally {
      if (run) this.runs.delete(run)
      finishOperatingRun(mission, entry, observed, failed)
      await this.store.save(mission)
    }
    if (failed) throw failure
    return output
  }

  private observeAttempt(expected: RunAttempt, observed: RunAttempt): RunAttempt {
    if (
      observed.id !== expected.id ||
      observed.issueId !== expected.issueId ||
      typeof observed.workspacePath !== "string" ||
      resolve(observed.workspacePath) !== resolve(expected.workspacePath)
    )
      throw new AgentRunError(
        "Runtime result belongs to another execution or workspace. Reconcile the intended run before resuming.",
        expected,
        { outcomeUnknown: true },
      )
    return observed
  }

  private async stopRun(run: RunHandle): Promise<void> {
    if (!run.isAlive()) {
      await this.joinRun(run)
      return
    }
    if (run.executionCapabilities.cancellation === "unsupported")
      throw new Error("Runtime cannot confirm cancellation. Reconcile the execution before resuming.")
    await run.cancel()
    if (run.executionCapabilities.cancellation !== "confirmed")
      throw new Error(
        "Runtime accepted cancellation without confirming completion. Reconcile the execution before resuming.",
      )
    await this.joinRun(run)
  }

  private async joinRun(run: RunHandle): Promise<void> {
    try {
      await run.result
    } catch (error) {
      if (error instanceof AgentRunError && error.outcomeUnknown) throw error
    }
  }

  private async awaitRun(run: RunHandle, attempt: RunAttempt, signal?: AbortSignal): Promise<RunAttempt> {
    if (!signal) return run.result
    let abort: (() => void) | undefined
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        void this.stopRun(run).then(
          () =>
            reject(
              signal.reason instanceof MissionPause
                ? signal.reason
                : new Error("Order interrupted. Resume the saved mission to continue."),
            ),
          (error) =>
            reject(
              new AgentRunError(error instanceof Error ? error.message : String(error), attempt, {
                outcomeUnknown: true,
              }),
            ),
        )
      }
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    try {
      return await Promise.race([run.result, interrupted])
    } finally {
      if (abort) signal.removeEventListener("abort", abort)
    }
  }
}
