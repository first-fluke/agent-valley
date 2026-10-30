import { createHash } from "node:crypto"
import { CheckpointError, ReadOnlyViolation } from "./coordinator-run"
import { ContractViolation } from "./coordinator-state"
import { assertExecutionDeadline, MissionPause } from "./execution"
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

export async function runStructuredStage<T>(options: StructuredStage<T>): Promise<T> {
  const { mission, stage, prompt, run, parse, save } = options
  const key = createHash("sha256")
    .update(`${stage}\0${options.scopeKey ?? stage}`)
    .digest("hex")
  let attempts = 0
  let reason = "No validated response is available for this saved context."
  for (const entry of mission.history) {
    if (!["structured-stage-attempt", "structured-stage-invalid"].includes(entry.stage)) continue
    let record: { key?: string; attempts?: number; reason?: string }
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
    attempts = Math.max(attempts, record.attempts ?? 0)
    if (typeof record.reason === "string") reason = record.reason.slice(0, 2_000)
  }
  while (attempts < 2) {
    assertExecutionDeadline(mission)
    attempts += 1
    mission.history.push({
      at: new Date().toISOString(),
      stage: "structured-stage-attempt",
      message: JSON.stringify({ key, attempts }),
    })
    await save(
      stage,
      `Reserved ${stage} structured response attempt ${attempts}/2 within the original execution budget.`,
    )
    // Run failures retain their existing safety/recovery semantics; only returned response parsing is corrected.
    const output = await run(
      attempts === 1
        ? prompt
        : `${prompt}\n\nThe previous response did not validate: ${JSON.stringify(reason)}. Return only one JSON object matching the original schema. Preserve the original goal, criteria, Actor identity and permissions. Do not add Markdown or commentary.`,
    )
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
