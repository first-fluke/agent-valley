import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { runVerificationGate, type VerificationGateResult } from "../orchestrator/verification-gate"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import type { ActiveMissionProcess } from "./active-process"
import { cargoCompilerCacheEnvironment } from "./cargo-toolchain"
import { finishLocalProcess } from "./local-runner"
import type { IntegrationCheckContext, Mission } from "./types"
import { type CheckEvidence, executeCommandChecks } from "./verification"
import { assertMissionWorkspace } from "./workspace"
import { directorySizes, growthReport, growthThresholdBytes, STORAGE_NOTE_PREFIX } from "./workspace-growth"
import { releaseWorkspaceScratch, scratchNote } from "./workspace-scratch"

export const INTEGRATION_CHECK_ENV = "AV_INTEGRATION_CHECK"
export const INTEGRATION_CHECK_COMMAND_ENV = "AV_INTEGRATION_CHECK_COMMAND"
export const INTEGRATION_CHANGED_FILES_FILE_ENV = "AV_INTEGRATION_CHANGED_FILES_FILE"
export const INTEGRATION_TASK_IDS_ENV = "AV_INTEGRATION_TASK_IDS"
export const INTEGRATION_OPEN_TASKS_ENV = "AV_INTEGRATION_OPEN_TASKS"

/**
 * The operator's own gate command for the integrated tree, for example
 * `cargo test --workspace && bun test && SKIP_COVERAGE=1 ./scripts/harness/validate.sh`.
 * Verification-contract commands are limited to a few fixed shapes, so project gates such as an
 * architecture harness could otherwise run only inside an Actor and fail first at the final gate task.
 */
export function integrationCheckCommand(source: NodeJS.ProcessEnv = process.env): string | undefined {
  return source[INTEGRATION_CHECK_COMMAND_ENV]?.trim() || undefined
}

/**
 * `AV_INTEGRATION_CHECK=1` runs contract commands between waves; an operator command enables it too.
 * The command alone replaces the contract's commands. With both set, the contract's commands run first and
 * the operator's command adds the gates a contract cannot express, so it should not repeat them.
 */
export function integrationCheckEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  return source[INTEGRATION_CHECK_ENV] === "1" || integrationCheckCommand(source) !== undefined
}

/** Reviewers need the command, the verdict and the end of the output, where a chained command reports its failure. */
export function operatorIntegrationResult(
  command: string,
  result: Pick<VerificationGateResult, "ok" | "output" | "timedOut">,
  logPath?: string,
): { ok: boolean; output: string } {
  const verdict = result.ok
    ? "PASS: the operator's integration command exited zero."
    : result.timedOut
      ? "FAIL: the operator's integration command timed out."
      : "FAIL: the operator's integration command exited nonzero. Output tail:"
  // The retained tail often ends in passing steps; the failing step of a chained gate is in the file.
  const complete = logPath ? `\nComplete output of this check: ${logPath}` : ""
  const tail = result.ok ? "" : `\n${(result.output ?? "").slice(-6_000)}`
  return { ok: result.ok, output: `${command.slice(0, 600)}${complete}\n${verdict}${tail}`.slice(0, 8_000) }
}

const CHECK_LOGS_KEPT = 12

/** A file under the mission's own `.agent-valley` directory, outside product paths and task deliveries. */
export async function integrationCheckLog(workspacePath: string, now: Date = new Date()): Promise<string | undefined> {
  try {
    const directory = join(workspacePath, ".agent-valley", "integration-checks")
    await mkdir(directory, { recursive: true })
    const earlier = (await readdir(directory)).filter((name) => name.endsWith(".log")).sort()
    for (const name of earlier.slice(0, Math.max(0, earlier.length - (CHECK_LOGS_KEPT - 1))))
      await rm(join(directory, name), { force: true })
    return join(directory, `${now.toISOString().replace(/[:.]/g, "-")}.log`)
  } catch {
    // The log is a convenience; a check never fails because it could not be written.
    return undefined
  }
}

/**
 * Forward wave scope to an operator's integration check via `extraEnv` without exposing orchestrator secrets.
 * When AV captured a changeSet for every task under review, changed relative paths are written to a file under
 * `.agent-valley/integration-checks` so language-specific runners can scope mid-cycle checks safely.
 */
export async function integrationCheckContextEnv(
  workspacePath: string,
  context: IntegrationCheckContext | undefined,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  if (!context) return {}
  const env: Record<string, string> = {
    [INTEGRATION_TASK_IDS_ENV]: context.taskIds.join(","),
    [INTEGRATION_OPEN_TASKS_ENV]: String(context.openCodeTasks),
  }
  if (context.changedFiles !== undefined) {
    try {
      const directory = join(workspacePath, ".agent-valley", "integration-checks")
      await mkdir(directory, { recursive: true })
      const earlier = (await readdir(directory)).filter((name) => name.endsWith(".changed-files.txt")).sort()
      for (const name of earlier.slice(0, Math.max(0, earlier.length - (CHECK_LOGS_KEPT - 1))))
        await rm(join(directory, name), { force: true })
      const filePath = join(directory, `${now.toISOString().replace(/[:.]/g, "-")}.changed-files.txt`)
      const body = context.changedFiles.length ? `${context.changedFiles.join("\n")}\n` : ""
      await writeFile(filePath, body, { encoding: "utf8", mode: 0o600 })
      env[INTEGRATION_CHANGED_FILES_FILE_ENV] = filePath
    } catch {
      // Omit the file path on error so the runner falls back to a full-workspace check.
    }
  }
  return env
}

export const LANE_CHECK_COMMAND_ENV = "AV_LANE_CHECK_COMMAND"
export const LANE_CHECK_TIMEOUT_ENV = "AV_LANE_CHECK_TIMEOUT_SEC"

/**
 * The operator's quick command for one Actor's isolated workspace, for example a formatter, a linter and an
 * architecture check. A delivery used to meet its first machine check only after every Actor of the wave had
 * returned and the tree was integrated, so a failure a twenty-second command finds cost a whole round of
 * Actor run, integration check and review. This command runs as soon as the Actor returns, and its failure
 * goes straight back to that Actor.
 */
export function laneCheckCommand(source: NodeJS.ProcessEnv = process.env): string | undefined {
  return source[LANE_CHECK_COMMAND_ENV]?.trim() || undefined
}

export async function runLaneCheck(
  mission: Mission,
  workspacePath: string,
  signal?: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; output: string } | undefined> {
  const command = laneCheckCommand(source)
  if (!command) return undefined
  const seconds = Number(source[LANE_CHECK_TIMEOUT_ENV])
  const cacheEnv = await cargoCompilerCacheEnvironment(workspacePath, source)
  const result = await runVerificationGate({ ...mission.workspace, path: workspacePath }, command, {
    timeoutSec: Number.isFinite(seconds) && seconds > 0 ? seconds : 900,
    signal,
    ...(Object.keys(cacheEnv).length ? { extraEnv: cacheEnv } : {}),
  })
  const verdict = result.ok
    ? "PASS"
    : result.timedOut
      ? "FAIL: the command timed out."
      : "FAIL: the command exited nonzero. Output tail:"
  return {
    ok: result.ok,
    output: `${command.slice(0, 600)}\n${verdict}${result.ok ? "" : `\n${(result.output ?? "").slice(-6_000)}`}`.slice(
      0,
      8_000,
    ),
  }
}

/** A failing part leads, so the reviewer's excerpt of the result starts with what has to be repaired. */
export function combinedIntegrationResult(
  contract: { ok: boolean; output: string },
  operator: { ok: boolean; output: string },
): { ok: boolean; output: string } {
  // A chained command reports its failure at the end of its output, so keep both ends of a long part.
  const clip = (text: string) => (text.length <= 3_900 ? text : `${text.slice(0, 700)}\n…\n${text.slice(-3_100)}`)
  const parts = [contract, operator].sort((a, b) => Number(a.ok) - Number(b.ok))
  return { ok: contract.ok && operator.ok, output: parts.map((part) => clip(part.output)).join("\n\n") }
}

/**
 * Evidence verification may reuse: every contract command passed and running them left the workspace as it
 * was. Any later change to a product file gives the workspace another fingerprint and voids it.
 */
export function reusableEvidence(
  result: { ok: boolean; evidence: readonly CheckEvidence[] },
  before: string,
  after: string,
  now: Date = new Date(),
): Mission["integrationEvidence"] {
  const checks = result.evidence.filter((entry) => entry.passed && entry.exitCode === 0 && entry.outputSha256)
  if (!result.ok || before !== after || !checks.length || checks.length !== result.evidence.length) return undefined
  return { fingerprint: after, checkedAt: now.toISOString(), checks: checks.slice(0, 40) }
}

/** Passing command evidence of the integration check, only while the workspace is byte-identical to that run. */
export async function integrationEvidenceFor(
  mission: Mission,
  fingerprint: (path: string) => Promise<string> = fingerprintWorkspace,
): Promise<readonly CheckEvidence[] | undefined> {
  const evidence = mission.integrationEvidence
  if (!evidence) return undefined
  try {
    return (await fingerprint(mission.workspace.path)) === evidence.fingerprint ? evidence.checks : undefined
  } catch {
    return undefined
  }
}

/** Runs under the same process guard as verification so an interrupted check is reclaimed on resume. */
export async function runIntegrationCheck(
  mission: Mission,
  active: ActiveMissionProcess,
  signal?: AbortSignal,
  source: NodeJS.ProcessEnv = process.env,
  context?: IntegrationCheckContext,
): Promise<{ ok: boolean; output: string } | undefined> {
  const command = integrationCheckCommand(source)
  if (!command && !mission.verificationContract) return undefined
  await assertMissionWorkspace(mission)
  // Declared scratch of earlier runs goes first, so the growth below is what this check alone leaves behind.
  const cleared = scratchNote(await releaseWorkspaceScratch(mission.workspace.path, source))
  const threshold = growthThresholdBytes(source)
  const before = threshold > 0 ? await directorySizes(mission.workspace.path) : undefined
  const result = await checkIntegratedTree(mission, active, command, signal, source, context)
  if (!result) return result
  const growth = before ? growthReport(before, await directorySizes(mission.workspace.path), threshold) : undefined
  // Storage findings lead, where the reviewer's excerpt starts; one line so the history can quote it.
  const storage = [cleared, growth]
    .filter((note): note is string => note !== undefined)
    .map((note, index) => (index ? note.slice(STORAGE_NOTE_PREFIX.length + 1) : note))
    .join(" ")
  return storage ? { ok: result.ok, output: `${storage}\n${result.output}`.slice(0, 8_000) } : result
}

async function checkIntegratedTree(
  mission: Mission,
  active: ActiveMissionProcess,
  command: string | undefined,
  signal: AbortSignal | undefined,
  source: NodeJS.ProcessEnv,
  context?: IntegrationCheckContext,
): Promise<{ ok: boolean; output: string } | undefined> {
  active.begin("verify")
  try {
    const operator = async () => {
      const logPath = await integrationCheckLog(mission.workspace.path)
      const [cacheEnv, contextEnv] = await Promise.all([
        cargoCompilerCacheEnvironment(mission.workspace.path, source),
        integrationCheckContextEnv(mission.workspace.path, context),
      ])
      const extraEnv = { ...cacheEnv, ...contextEnv }
      return operatorIntegrationResult(
        command ?? "",
        await runVerificationGate(mission.workspace, command ?? "", {
          timeoutSec: mission.timeoutSec,
          signal,
          onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
          ...(Object.keys(extraEnv).length ? { extraEnv } : {}),
          ...(logPath ? { outputFile: logPath } : {}),
        }),
        logPath,
      )
    }
    // Alone, the operator's command is the project's whole cheap gate and replaces the contract's commands.
    if (command && (source[INTEGRATION_CHECK_ENV] !== "1" || !mission.verificationContract)) return await operator()
    delete mission.integrationEvidence
    const before = await fingerprintWorkspace(mission.workspace.path)
    const contract = await executeCommandChecks(mission.verificationContract, mission.workspace.path, {
      successCriteria: mission.goalBrief?.successCriteria ?? [],
      timeoutMs: mission.timeoutSec * 1_000,
      signal,
      onSpawned: (pid, detached) => active.spawned(pid, detached),
    })
    if (contract) {
      const evidence = reusableEvidence(contract, before, await fingerprintWorkspace(mission.workspace.path))
      if (evidence) mission.integrationEvidence = evidence
    }
    if (!command) return contract ? { ok: contract.ok, output: contract.output } : undefined
    if (!contract) return await operator()
    await finishLocalProcess(active)
    active.begin("verify")
    const extra = await operator()
    // The operator's gates may rewrite files; evidence stays bound to the fingerprint it was observed on.
    return combinedIntegrationResult(contract, extra)
  } finally {
    await finishLocalProcess(active)
  }
}
