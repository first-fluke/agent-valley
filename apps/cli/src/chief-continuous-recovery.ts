import type { ContinuousDecision } from "@agent-valley/core/chief/continuous-contract"
import { parseContinuousDecision } from "@agent-valley/core/chief/continuous-contract"
import { CheckpointError, ReadOnlyViolation } from "@agent-valley/core/chief/coordinator-run"
import {
  assertExecutionBudget,
  assertExecutionDeadline,
  classifyFailure,
  executionState,
  MissionPause,
  recordPause,
} from "@agent-valley/core/chief/execution"
import type { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { abortableDelay } from "./chief-supervisor"

export function assertContinuousDecisionRecovery(mission: Mission): void {
  const state = executionState(mission)
  if (
    mission.status === "paused" &&
    state.failureKind !== "implementation" &&
    state.failureKind !== "provider" &&
    state.failureKind !== "rate-limit"
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
  if (mission.status === "paused" && state.retries >= (mission.executionPolicy?.maxRetries ?? 0))
    throw new MissionPause(
      mission.error ?? "Bounded Chief decision recovery exhausted its attempts.",
      state.failureKind ?? "implementation",
    )
  let correction = mission.history.findLast((entry) => entry.stage === "continuous-decision-invalid")?.message
  while (true) {
    while (state.nextRunAt && Date.parse(state.nextRunAt) > Date.now()) {
      assertExecutionDeadline(mission)
      const remaining = mission.executionPolicy
        ? Date.parse(state.startedAt) + mission.executionPolicy.maxDurationSec * 1000 - Date.now()
        : Infinity
      await delay(Math.min(Date.parse(state.nextRunAt) - Date.now(), remaining, 30_000), signal)
    }
    if (signal?.aborted) throw new MissionPause("Operation decision interrupted.", "interrupted")
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
