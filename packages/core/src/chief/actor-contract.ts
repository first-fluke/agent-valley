import { z } from "zod"
import type { Actor, ChiefPlan, ChiefTask } from "./types"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)

/** Canonical actor input is normalized to the native and saved agentType field. */
export const actorSchema = z
  .strictObject({
    id,
    name: text,
    role: text,
    actorType: text.optional(),
    agentType: text.optional(),
    model: text.optional(),
    skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)).max(30),
  })
  .superRefine((actor, ctx) => {
    if (!actor.actorType && !actor.agentType)
      ctx.addIssue({ code: "custom", path: ["actorType"], message: "Set actorType to the actor's native CLI type." })
    if (actor.actorType && actor.agentType && actor.actorType !== actor.agentType)
      ctx.addIssue({ code: "custom", path: ["actorType"], message: "actorType conflicts with legacy agentType." })
  })
  .transform(({ actorType, agentType, ...actor }): Actor => ({ ...actor, agentType: actorType ?? agentType ?? "" }))

export const actorTaskSchema = z
  .strictObject({
    id,
    title: text,
    actorId: id.optional(),
    personaId: id.optional(),
    instructions: text,
    acceptance: z.array(text).min(1).max(20),
    dependencies: z.array(id).max(11),
    effectScope: z.enum(["workspace", "external"]).optional(),
  })
  .superRefine((task, ctx) => {
    if (!task.actorId && !task.personaId)
      ctx.addIssue({ code: "custom", path: ["actorId"], message: "Assign a configured actorId to this task." })
    if (task.actorId && task.personaId && task.actorId !== task.personaId)
      ctx.addIssue({ code: "custom", path: ["actorId"], message: "actorId conflicts with legacy personaId." })
  })
  .transform(({ actorId, personaId, ...task }): ChiefTask => ({ ...task, personaId: actorId ?? personaId ?? "" }))

export function actorData({ agentType, ...actor }: Actor) {
  return { ...actor, actorType: agentType }
}

export function actorTaskData({ personaId, ...task }: ChiefTask) {
  return { ...task, actorId: personaId }
}

export function actorPlanData(plan?: ChiefPlan) {
  return plan ? { tasks: plan.tasks.map(actorTaskData) } : undefined
}

export function normalizeActorAssignment(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const input = value as Record<string, unknown>
  if (input.action !== "reassign" || input.actorId === undefined) return value
  if (input.personaId !== undefined && input.personaId !== input.actorId)
    throw new Error("Recovery actorId conflicts with legacy personaId. Choose one existing Actor.")
  const { actorId, ...rest } = input
  return { ...rest, personaId: actorId }
}
