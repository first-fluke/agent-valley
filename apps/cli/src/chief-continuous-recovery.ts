import { randomUUID } from "node:crypto"
import type { ContinuousDecision } from "@agent-valley/core/chief/continuous-contract"
import { parseContinuousDecision } from "@agent-valley/core/chief/continuous-contract"
import { CheckpointError, ReadOnlyViolation } from "@agent-valley/core/chief/coordinator-run"
import {
  assertExecutionBudget,
  assertExecutionDeadline,
  assertNoUncertainExecution,
  classifyFailure,
  executionState,
  MissionPause,
  recordPause,
} from "@agent-valley/core/chief/execution"
import { interruptionPause } from "@agent-valley/core/chief/service-shutdown"
import type { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { abortableDelay } from "./chief-supervisor"

/**
 * An explicit operator retry reopens a decision the operator interrupted, or permits one corrected response without
 * replenishing automatic retries. Spent calls, retries and the original deadline stay recorded in both cases.
 */
export function rearmContinuousDecision(mission: Mission): void {
  const state = executionState(mission)
  const reason = mission.error ?? state.pauseReason ?? ""
  if (mission.status === "paused" && state.failureKind === "interrupted") {
    assertNoUncertainExecution(mission)
    assertExecutionBudget(mission)
    mission.history.push({
      at: new Date().toISOString(),
      stage: "continuous-decision-operator-resume",
      message: `Operator resumed the interrupted decision; ${state.runsStarted} spent calls and ${state.retries} automatic retries remain recorded.`,
    })
    mission.status = "planning"
    delete mission.error
    delete state.pauseReason
    delete state.failureKind
    delete state.nextRunAt
    return
  }
  if (
    mission.status !== "paused" ||
    state.failureKind !== "implementation" ||
    !reason.startsWith("Invalid Chief decision")
  )
    throw new Error(
      "Operation --retry requires a paused decision that the operator interrupted or that returned invalid JSON. Inspect its saved blocker or resume the active child instead.",
    )
  assertNoUncertainExecution(mission)
  assertExecutionBudget(mission)
  mission.history.push({
    at: new Date().toISOString(),
    stage: "continuous-decision-operator-retry",
    message: `${randomUUID()}: Operator authorized one corrected JSON decision after repairing its source; ${state.runsStarted} spent calls and ${state.retries} automatic retries remain recorded.`,
  })
}

export function assertContinuousDecisionRecovery(mission: Mission): void {
  const state = executionState(mission)
  if (
    mission.status === "paused" &&
    state.failureKind !== "implementation" &&
    state.failureKind !== "provider" &&
    state.failureKind !== "rate-limit" &&
    state.failureKind !== "service-shutdown"
  )
    throw new MissionPause(
      mission.error ?? state.pauseReason ?? "The saved decision remains unresolved.",
      state.failureKind ?? "implementation",
    )
}

/** Validation corrections reuse the same decision, Chief, evidence and spent budget. */
export async function runContinuousDecision(
  mission: Mission,
  prompt: string,
  run: (prompt: string) => Promise<string>,
  store: MissionStore,
  signal?: AbortSignal,
  delay = abortableDelay,
): Promise<ContinuousDecision> {
  assertContinuousDecisionRecovery(mission)
  const state = executionState(mission)
  const permit = mission.history.findLast((entry) => entry.stage === "continuous-decision-operator-retry")
  const authorized =
    permit &&
    !mission.history.some(
      (entry) => entry.stage === "continuous-decision-operator-retry-consumed" && entry.message === permit.message,
    )
  if (
    mission.status === "paused" &&
    state.failureKind !== "service-shutdown" &&
    state.retries >= (mission.executionPolicy?.maxRetries ?? 0) &&
    !authorized
  )
    throw new MissionPause(
      mission.error ?? "Bounded Chief decision recovery exhausted its attempts.",
      state.failureKind ?? "implementation",
    )
  if (authorized) {
    assertNoUncertainExecution(mission)
    assertExecutionBudget(mission)
    mission.history.push({
      at: new Date().toISOString(),
      stage: "continuous-decision-operator-retry-consumed",
      message: permit.message,
    })
    await store.save(mission)
  }
  let correction = mission.history.findLast((entry) => entry.stage === "continuous-decision-invalid")?.message
  while (true) {
    while (state.nextRunAt && Date.parse(state.nextRunAt) > Date.now()) {
      assertExecutionDeadline(mission)
      const remaining = mission.executionPolicy
        ? Date.parse(state.startedAt) + mission.executionPolicy.maxDurationSec * 1000 - Date.now()
        : Infinity
      await delay(Math.min(Date.parse(state.nextRunAt) - Date.now(), remaining, 30_000), signal)
    }
    if (signal?.aborted)
      throw interruptionPause(
        signal,
        "Operation decision interrupted. Resume it explicitly with av order --resume <operation-id> --retry.",
      )
    mission.status = "planning"
    delete mission.error
    delete state.pauseReason
    delete state.failureKind
    delete state.nextRunAt
    await store.save(mission)
    try {
      return parseContinuousDecision(
        await run(
          correction
            ? `${prompt}\n\nCorrect the previous response: ${correction}\nReturn one valid JSON object under the original charter and pinned evidence.`
            : prompt,
        ),
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const kind = error instanceof MissionPause ? error.kind : classifyFailure(reason)
      const invalid = reason.startsWith("Invalid Chief decision")
      if (invalid) {
        correction = reason
        mission.history.push({ at: new Date().toISOString(), stage: "continuous-decision-invalid", message: reason })
      }
      const recoverable =
        !(error instanceof ReadOnlyViolation) &&
        !(error instanceof CheckpointError) &&
        (invalid || kind === "provider" || kind === "rate-limit")
      if (!recoverable || !mission.executionPolicy?.autoResume || state.retries >= mission.executionPolicy.maxRetries)
        throw error instanceof MissionPause
          ? error
          : new MissionPause(
              `${reason}${recoverable ? " Bounded Chief decision recovery exhausted its attempts; the saved decision remains unresolved." : ""}`,
              error instanceof CheckpointError || error instanceof ReadOnlyViolation ? "integrity" : kind,
            )
      assertExecutionBudget(mission)
      state.retries += 1
      const nextRunAt = new Date(
        Date.now() + Math.min(300_000, mission.executionPolicy.retryDelayMs * 2 ** (state.retries - 1)),
      ).toISOString()
      recordPause(mission, new MissionPause(reason, invalid ? "implementation" : kind, nextRunAt))
      mission.history.push({
        at: new Date().toISOString(),
        stage: "continuous-decision-retry",
        message: `Correcting the same decision, bounded recovery ${state.retries}/${mission.executionPolicy.maxRetries}.`,
      })
      await store.save(mission)
    }
  }
}
