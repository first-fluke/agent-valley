import { createHash } from "node:crypto"
import { AgentRunError } from "../domain/ports/agent-runner"
import { CheckpointError, ReadOnlyViolation } from "./coordinator-run"
import { ContractViolation } from "./coordinator-state"
import { assertExecutionDeadline, assertNoUncertainExecution, isNativeAgentTimeout, MissionPause } from "./execution"
import type { ChiefStage, Mission } from "./types"

export class StructuredStageError extends Error {
  constructor(
    readonly stage: ChiefStage,
    reason: string,
  ) {
    super(`${stage} did not produce a validated response within two saved attempts. ${reason}`)
  }
}

interface StructuredStage<T> {
  mission: Mission
  stage: ChiefStage
  prompt: string
  scopeKey?: string
  run(prompt: string): Promise<string>
  parse(output: string): T
  save(stage: string, message: string): Promise<void>
}

interface LegacyTimeout {
  key: string
  attempts: number
  legacyRunId: string
  reservationAt: string
  pauseAt: string
}

/** Only the old planning-timeout wrapper plus one settled native run establishes this missing release. */
function legacyPlanningTimeout(mission: Mission, stage: ChiefStage, key: string): LegacyTimeout | undefined {
  const runs = mission.operations?.runs ?? []
  if (
    stage !== "plan" ||
    !runs.length ||
    runs.some(
      (run) =>
        run.executionState === "unknown" ||
        run.executionState === "running" ||
        !run.finishedAt ||
        !Number.isFinite(Date.parse(run.startedAt)) ||
        !Number.isFinite(Date.parse(run.finishedAt)),
    )
  )
    return
  const candidates: LegacyTimeout[] = []
  const pausePattern =
    /^The selected Chief Director could not complete plan: Agent timed out after (\d+(?:\.\d+)?)s\. Its goal, model and spent limits were retained; the outcome remains unresolved\.$/
  for (let index = 0; index < mission.history.length; index += 1) {
    const reservation = mission.history[index]
    if (reservation?.stage !== "structured-stage-attempt") continue
    let record: { key?: string; attempts?: number }
    try {
      record = JSON.parse(reservation.message) as typeof record
    } catch {
      continue
    }
    if (record.key !== key || ![1, 2].includes(record.attempts ?? 0)) continue
    const reservedAt = Date.parse(reservation.at)
    let pause: Mission["history"][number] | undefined
    let seconds = 0
    for (const entry of mission.history.slice(index + 1)) {
      if (
        ["structured-stage-attempt", "structured-stage-invalid", "structured-stage-transient"].includes(entry.stage)
      ) {
        let following: { key?: string }
        try {
          following = JSON.parse(entry.message) as typeof following
        } catch {
          break
        }
        if (following.key === key) break
      }
      const match = entry.stage === "paused" && !entry.taskId ? pausePattern.exec(entry.message) : null
      if (match) {
        pause = entry
        seconds = Number(match[1])
        break
      }
    }
    const pausedAt = Date.parse(pause?.at ?? "")
    if (!pause || !Number.isFinite(reservedAt) || !Number.isFinite(pausedAt) || pausedAt < reservedAt || !(seconds > 0))
      continue
    const overlapping = runs.filter(
      (run) => Date.parse(run.startedAt) <= pausedAt && Date.parse(run.finishedAt ?? "") >= reservedAt,
    )
    const run = overlapping.length === 1 ? overlapping[0] : undefined
    if (
      !run ||
      run.stage !== stage ||
      run.actorId !== mission.chiefId ||
      run.taskId ||
      run.executionState !== "settled" ||
      run.outcome !== "failed" ||
      Date.parse(run.startedAt) < reservedAt ||
      Date.parse(run.finishedAt ?? "") > pausedAt ||
      (run.elapsedMs ?? 0) < seconds * 1_000 ||
      Date.parse(run.finishedAt ?? "") - Date.parse(run.startedAt) < seconds * 1_000
    )
      continue
    candidates.push({
      key,
      attempts: record.attempts as number,
      legacyRunId: run.runId,
      reservationAt: reservation.at,
      pauseAt: pause.at,
    })
  }
  // Multiple historical timeouts need explicit reconciliation rather than inferred slot arithmetic.
  return candidates.length === 1 ? candidates[0] : undefined
}

export async function runStructuredStage<T>(options: StructuredStage<T>): Promise<T> {
  const { mission, stage, prompt, run, parse, save } = options
  const key = createHash("sha256")
    .update(`${stage}\0${options.scopeKey ?? stage}`)
    .digest("hex")
  let attempts = 0
  let reason = "No validated response is available for this saved context."
  const legacy = legacyPlanningTimeout(mission, stage, key)
  let legacyReleased = false
  let pendingReservation: { attempts: number; at: string } | undefined
  for (const entry of mission.history) {
    if (!["structured-stage-attempt", "structured-stage-invalid", "structured-stage-transient"].includes(entry.stage))
      continue
    let record: {
      key?: string
      attempts?: number
      reason?: string
      legacyRunId?: string
      reservationAt?: string
      pauseAt?: string
    }
    try {
      record = JSON.parse(entry.message) as typeof record
    } catch {
      throw new CheckpointError(
        "Structured response history is invalid. Restore the original checkpoint before retrying.",
      )
    }
    if (record.key !== key) continue
    if (!Number.isInteger(record.attempts) || (record.attempts ?? 0) < 1 || (record.attempts ?? 3) > 2)
      throw new CheckpointError("Structured response attempt history is invalid. Preserve its spent attempt count.")
    if (entry.stage === "structured-stage-transient") {
      if (record.legacyRunId !== undefined) {
        if (
          !legacy ||
          legacyReleased ||
          record.legacyRunId !== legacy.legacyRunId ||
          record.attempts !== legacy.attempts ||
          record.reservationAt !== legacy.reservationAt ||
          record.pauseAt !== legacy.pauseAt ||
          attempts < 1
        )
          throw new CheckpointError(
            "Legacy timeout release history lacks unique settled execution proof. Restore the original checkpoint before retrying.",
          )
        legacyReleased = true
        if (pendingReservation?.at === record.reservationAt) pendingReservation = undefined
        attempts -= 1
        continue
      }
      if (
        record.attempts !== attempts ||
        pendingReservation?.attempts !== record.attempts ||
        (record.reservationAt !== undefined && record.reservationAt !== pendingReservation.at)
      )
        throw new CheckpointError(
          "Structured response timeout history has no matching reservation. Restore the original checkpoint before retrying.",
        )
      pendingReservation = undefined
      attempts -= 1
      continue
    }
    if (entry.stage === "structured-stage-attempt")
      pendingReservation = { attempts: record.attempts ?? 0, at: entry.at }
    if (entry.stage === "structured-stage-invalid") pendingReservation = undefined
    attempts = Math.max(attempts, record.attempts ?? 0)
    if (typeof record.reason === "string") reason = record.reason.slice(0, 2_000)
  }
  if (legacy && !legacyReleased) {
    mission.history.push({
      at: new Date().toISOString(),
      stage: "structured-stage-transient",
      message: JSON.stringify(legacy),
    })
    await save(
      "structured-output",
      `Reconciled legacy planning timeout ${legacy.legacyRunId} from its reservation, exact pause and settled execution evidence. Retained all spent calls, time, cost and retries; only its unused JSON response slot was released.`,
    )
    attempts -= 1
  }
  while (attempts < 2) {
    assertExecutionDeadline(mission)
    attempts += 1
    const reservationAt = new Date().toISOString()
    mission.history.push({
      at: reservationAt,
      stage: "structured-stage-attempt",
      message: JSON.stringify({ key, attempts }),
    })
    await save(
      stage,
      `Reserved ${stage} structured response attempt ${attempts}/2 within the original execution budget.`,
    )
    // Run failures retain their existing safety/recovery semantics; only returned response parsing is corrected.
    let output: string
    try {
      output = await run(
        attempts === 1
          ? prompt
          : `${prompt}\n\nThe previous response did not validate: ${JSON.stringify(reason)}. Return only one JSON object matching the original schema. Preserve the original goal, criteria, Actor identity and permissions. Do not add Markdown or commentary.`,
      )
    } catch (error) {
      if (
        error instanceof Error &&
        !(error instanceof MissionPause) &&
        !(error instanceof AgentRunError && error.outcomeUnknown) &&
        isNativeAgentTimeout(error.message)
      ) {
        assertNoUncertainExecution(mission)
        mission.history.push({
          at: new Date().toISOString(),
          stage: "structured-stage-transient",
          message: JSON.stringify({ key, attempts, reservationAt }),
        })
        await save(
          "structured-output",
          `${stage} ended at its native deadline without a response. Retained the JSON correction allowance; Actor calls, elapsed time, cost and provider retries remain spent.`,
        )
      }
      throw error
    }
    try {
      return parse(output)
    } catch (error) {
      if (
        error instanceof MissionPause ||
        error instanceof ReadOnlyViolation ||
        error instanceof ContractViolation ||
        error instanceof CheckpointError
      )
        throw error
      reason = (error instanceof Error ? error.message : "Response failed schema validation.").slice(0, 2_000)
      mission.history.push({
        at: new Date().toISOString(),
        stage: "structured-stage-invalid",
        message: JSON.stringify({ key, attempts, reason }),
      })
      await save("structured-output", `${stage} response did not match the original schema (attempt ${attempts}/2).`)
    }
  }
  throw new StructuredStageError(stage, reason)
}
