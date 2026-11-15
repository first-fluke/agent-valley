import { runVerificationGate, type VerificationGateResult } from "../orchestrator/verification-gate"
import { fingerprintWorkspace } from "../workspace/fingerprint"
import type { ActiveMissionProcess } from "./active-process"
import { finishLocalProcess } from "./local-runner"
import type { Mission } from "./types"
import { type CheckEvidence, executeCommandChecks } from "./verification"
import { assertMissionWorkspace } from "./workspace"

export const INTEGRATION_CHECK_ENV = "AV_INTEGRATION_CHECK"
export const INTEGRATION_CHECK_COMMAND_ENV = "AV_INTEGRATION_CHECK_COMMAND"

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
): { ok: boolean; output: string } {
  const verdict = result.ok
    ? "PASS: the operator's integration command exited zero."
    : result.timedOut
      ? "FAIL: the operator's integration command timed out."
      : "FAIL: the operator's integration command exited nonzero. Output tail:"
  const tail = result.ok ? "" : `\n${(result.output ?? "").slice(-6_000)}`
  return { ok: result.ok, output: `${command.slice(0, 600)}\n${verdict}${tail}`.slice(0, 8_000) }
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
): Promise<{ ok: boolean; output: string } | undefined> {
  const command = integrationCheckCommand(source)
  if (!command && !mission.verificationContract) return undefined
  await assertMissionWorkspace(mission)
  active.begin("verify")
  try {
    const operator = async () =>
      operatorIntegrationResult(
        command ?? "",
        await runVerificationGate(mission.workspace, command ?? "", {
          timeoutSec: mission.timeoutSec,
          signal,
          onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
        }),
      )
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
