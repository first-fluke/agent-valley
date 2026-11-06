import { z } from "zod"

export const handoffRouteSchema = z.strictObject({
  agentType: z.enum(["claude", "codex", "qwen", "antigravity", "cursor", "grok", "kimi", "opencode"]),
  model: z.string().min(1).max(2_000).optional(),
})

export const handoffStateSchema = z.strictObject({
  exhaustedAgents: z.array(handoffRouteSchema.shape.agentType).max(8),
  routes: z.record(z.string().min(1).max(64), handoffRouteSchema),
  continuations: z.record(z.string().min(1).max(256), z.number().int().min(0).max(1)),
})

export type HandoffState = z.infer<typeof handoffStateSchema>
