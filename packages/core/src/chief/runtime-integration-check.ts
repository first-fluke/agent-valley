import { runVerificationGate, type VerificationGateResult } from "../orchestrator/verification-gate"
import type { ActiveMissionProcess } from "./active-process"
import { finishLocalProcess } from "./local-runner"
import type { Mission } from "./types"
import { executeCommandChecks } from "./verification"
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

/** `AV_INTEGRATION_CHECK=1` runs contract commands between waves; an operator command enables it too. */
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
    // The operator's command is the project's whole cheap gate, so it replaces the contract's commands.
    if (command)
      return operatorIntegrationResult(
        command,
        await runVerificationGate(mission.workspace, command, {
          timeoutSec: mission.timeoutSec,
          signal,
          onSpawned: (pid) => active.spawned(pid, process.platform !== "win32"),
        }),
      )
    return await executeCommandChecks(mission.verificationContract, mission.workspace.path, {
      successCriteria: mission.goalBrief?.successCriteria ?? [],
      timeoutMs: mission.timeoutSec * 1_000,
      signal,
      onSpawned: (pid, detached) => active.spawned(pid, detached),
    })
  } finally {
    await finishLocalProcess(active)
  }
}
