import { z } from "zod"
import { actorTaskData, actorTaskSchema, normalizeActorAssignment } from "./actor-contract"
import { parseJson, validatePlan } from "./plan-validation"
import type { ChiefPlan, Mission } from "./types"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)

export const supervisionResponseSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("repair"), reason: text, instructions: text, taskId: id.optional() }),
  z.strictObject({ action: z.literal("reassign"), reason: text, instructions: text, taskId: id, personaId: id }),
  z.strictObject({ action: z.literal("replan"), reason: text, tasks: z.array(actorTaskSchema).min(1).max(48) }),
  z.strictObject({ action: z.literal("stop"), reason: text }),
  z.strictObject({ action: z.literal("wait"), reason: text, retryAfterSec: z.number().int().min(1).max(86_400) }),
])

export type SupervisionResponse = z.infer<typeof supervisionResponseSchema>

export function validateOriginalAcceptance(plan: ChiefPlan, mission: Mission): void {
  const acceptance = new Set(plan.tasks.flatMap((task) => task.acceptance))
  if (mission.supervision?.originalAcceptance?.some((criterion) => !acceptance.has(criterion)))
    throw new Error(
      "The Chief Director replan weakens an original acceptance obligation. Retain every original acceptance criterion verbatim in the new tasks.",
    )
  for (const task of mission.plan?.tasks ?? []) {
    const effect = mission.tasks.find((state) => state.id === task.id)?.effectState
    if (
      task.effectScope === "external" &&
      effect &&
      effect !== "not-started" &&
      !plan.tasks.some((entry) => entry.id === task.id && entry.effectScope === "external")
    )
      throw new Error(
        "Replanning must retain recorded external-effect task identities and scopes. Reconcile uncertain actions before replacing them.",
      )
  }
}

/**
 * A replan entry `{"id":"task-1","retain":true}` keeps an accepted task exactly as recorded: its previous
 * definition replaces the entry, so its acceptance stays verbatim and its completed state survives the
 * replan. Rewriting an accepted task as a "retain the deliverable" assignment used to reset it and spend
 * an Actor run plus a review on a no-op. A retain flag on a task that was never accepted is dropped and
 * the entry must define the task normally.
 */
export function resolveRetainedReplanTasks(value: unknown, mission: Mission): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  if (input.action !== "replan" || !Array.isArray(input.tasks)) return value
  const tasks = input.tasks.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry
    const { retain, ...task } = entry as Record<string, unknown>
    if (retain !== true) return task
    const previous = mission.plan?.tasks.find((candidate) => candidate.id === task.id)
    const state = mission.tasks.find((candidate) => candidate.id === task.id)
    const accepted =
      previous &&
      state?.status === "completed" &&
      state.output !== undefined &&
      state.review?.passed === true &&
      state.fingerprint !== undefined
    return accepted ? actorTaskData(previous) : task
  })
  return { ...input, tasks }
}

export function parseSupervisionResponse(source: string, mission: Mission): SupervisionResponse {
  // The shared JSON bound in parseJson and the per-field text limits apply; a supervision-only
  // 8,000-character cutoff rejected valid repair decisions and burned a recovery round each time.
  const decision = supervisionResponseSchema.parse(
    normalizeActorAssignment(resolveRetainedReplanTasks(parseJson(source, "Supervision"), mission)),
  )
  if (
    mission.tasks.some((task) => task.effectState === "unknown") &&
    decision.action !== "wait" &&
    decision.action !== "stop"
  )
    throw new Error(
      "Uncertain external effects have no trustworthy destination proof. Chief recovery may only wait or stop; preserve the effect evidence without replay.",
    )
  if (decision.action === "replan") {
    const plan = { tasks: decision.tasks }
    validatePlan(plan, mission.personas)
    validateOriginalAcceptance(plan, mission)
  } else if (decision.action !== "stop" && decision.action !== "wait") {
    const taskId = decision.taskId ?? mission.supervision?.pendingRecovery?.taskId
    const task = mission.plan?.tasks.find((entry) => entry.id === taskId)
    if (taskId && !task) throw new Error(`Unknown recovery task ${taskId}. Select an existing mission task.`)
    if (decision.action === "reassign") {
      if (!mission.personas.some((persona) => persona.id === decision.personaId))
        throw new Error(`Unknown recovery Actor ${decision.personaId}. Select an existing mission Actor.`)
      if (task?.personaId === decision.personaId)
        throw new Error("Reassignment must choose a different Actor. Use repair to keep the current Actor.")
    }
  }
  return decision
}
