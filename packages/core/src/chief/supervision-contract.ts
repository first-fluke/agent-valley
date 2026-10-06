import { z } from "zod"
import { actorTaskSchema, normalizeActorAssignment } from "./actor-contract"
import { parseJson, validatePlan } from "./plan-validation"
import type { ChiefPlan, Mission } from "./types"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)

export const supervisionResponseSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("repair"), reason: text, instructions: text, taskId: id.optional() }),
  z.strictObject({ action: z.literal("reassign"), reason: text, instructions: text, taskId: id, personaId: id }),
  z.strictObject({ action: z.literal("replan"), reason: text, tasks: z.array(actorTaskSchema).min(1).max(12) }),
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

export function parseSupervisionResponse(source: string, mission: Mission): SupervisionResponse {
  if (source.length > 8_000)
    throw new Error("Chief Director supervision response exceeds 8,000 characters. Return a concise recovery decision.")
  const decision = supervisionResponseSchema.parse(normalizeActorAssignment(parseJson(source, "Supervision")))
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
