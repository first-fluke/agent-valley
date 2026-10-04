import { z } from "zod"
import { taskSchema } from "./task-schema"

export const actorTypeSchema = z.enum(["claude", "codex", "qwen", "antigravity", "cursor", "grok", "kimi", "opencode"])

export const actorDefaultsSchema = z.object({
  type: actorTypeSchema.optional(),
  model: z.string().trim().min(1).max(256).optional(),
  timeout: z.number().min(30).optional(),
  max_retries: z.number().min(1).optional(),
  retry_delay: z.number().min(1).optional(),
  max_parallel: z.number().min(1, "actor.max_parallel must be >= 1").optional(),
})

/** Canonical actor blocks replace the legacy block instead of mixing vendor/model defaults. */
export function normalizeActorDefaults<T extends { actor?: unknown; agent?: unknown }>(config: T): T {
  return { ...config, agent: config.actor ?? config.agent }
}

export const routingRuleSchema = z
  .object({
    label: z.string().min(1, "Each routing rule must have a non-empty label"),
    workspace_root: z
      .string()
      .min(1)
      .refine((v) => v.startsWith("/"), "workspace_root in routing rule must be an absolute path"),
    actor_type: actorTypeSchema.optional(),
    agent_type: actorTypeSchema.optional(),
    delivery_mode: z.enum(["merge", "pr"]).optional(),
    verify_command: z.string().min(1, "verify_command must be a non-empty shell command").optional(),
    task: taskSchema.optional(),
  })
  .overwrite((rule) => ({ ...rule, agent_type: rule.actor_type ?? rule.agent_type }))

const scoreRoutingTierSchema = z
  .object({
    min: z.number().int().min(1).max(10),
    max: z.number().int().min(1).max(10),
    actor: actorTypeSchema.optional(),
    agent: actorTypeSchema.optional(),
  })
  .refine((tier) => tier.min <= tier.max, "Each score tier must have min <= max")
  .refine((tier) => tier.actor !== undefined || tier.agent !== undefined, {
    path: ["actor"],
    message: "Each score tier must select an actor",
  })
  .transform((tier) => ({ ...tier, agent: (tier.actor ?? tier.agent) as z.infer<typeof actorTypeSchema> }))

export const scoreRoutingSchema = z
  .object({
    easy: scoreRoutingTierSchema,
    medium: scoreRoutingTierSchema,
    hard: scoreRoutingTierSchema,
  })
  .refine(
    (routes) => routes.easy.max < routes.medium.min && routes.medium.max < routes.hard.min,
    "Score tiers must not overlap. Ensure easy.max < medium.min and medium.max < hard.min",
  )
