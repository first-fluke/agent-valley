import { z } from "zod"
import { actorTypeSchema } from "../config/actor-schema"
import { AGENT_IDS } from "../domain/agent"

export const handoffRouteSchema = z.strictObject({
  agentType: actorTypeSchema,
  model: z.string().min(1).max(2_000).optional(),
})

export const handoffStateSchema = z.strictObject({
  exhaustedAgents: z.array(handoffRouteSchema.shape.agentType).max(AGENT_IDS.length),
  unavailableAgents: z.array(handoffRouteSchema.shape.agentType).max(AGENT_IDS.length).optional(),
  unavailableModels: z.record(z.string().min(1).max(64), z.array(z.string().min(1).max(2_000)).max(128)).optional(),
  freeModels: z.record(z.string().min(1).max(64), z.array(z.string().min(1).max(2_000)).max(128)).optional(),
  freeRoutes: z.record(z.string().min(1).max(64), z.string().min(1).max(2_000)).optional(),
  routes: z.record(z.string().min(1).max(64), handoffRouteSchema),
  continuations: z.record(z.string().min(1).max(256), z.number().int().min(0).max(1)),
  /** Consecutive no-verdict review failures per provider route; retires a fallback after two. */
  reviewerFailures: z.record(z.string().min(1).max(64), z.number().int().min(0).max(128)).optional(),
  /** Provider routes retired from review for this mission after repeated no-verdict failures. */
  retiredReviewRoutes: z.array(z.string().min(1).max(128)).max(AGENT_IDS.length).optional(),
})

export type HandoffState = z.infer<typeof handoffStateSchema>

export function unavailableProviders(state?: HandoffState): ReadonlySet<string> {
  return new Set([...(state?.exhaustedAgents ?? []), ...(state?.unavailableAgents ?? [])])
}
