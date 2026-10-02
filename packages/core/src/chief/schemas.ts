import { z } from "zod"
import { detectCycles } from "../domain/dag"
import type { DagNode } from "../domain/models"
import type { ChiefPlan, Mission, Persona, Review } from "./types"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)
const counter = z.number().int().min(0)

export const personaSchema = z.strictObject({
  id,
  name: text,
  role: text,
  agentType: text,
  model: text.optional(),
  skills: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)).max(30),
})

export const planSchema = z.strictObject({
  tasks: z
    .array(
      z.strictObject({
        id,
        title: text,
        personaId: id,
        instructions: text,
        acceptance: z.array(text).min(1).max(20),
        dependencies: z.array(id).max(11),
      }),
    )
    .min(1)
    .max(12),
})

export const reviewSchema = z
  .strictObject({
    passed: z.boolean(),
    summary: text,
    findings: z.array(text).max(50),
  })
  .superRefine((review, ctx) => {
    if (review.passed && review.findings.length > 0) {
      ctx.addIssue({ code: "custom", message: "A passing review must have no unresolved findings." })
    }
    if (!review.passed && review.findings.length === 0) {
      ctx.addIssue({ code: "custom", message: "A rejected review must include actionable findings." })
    }
  })

export const missionSchema = z.strictObject({
  id,
  goal: text,
  chiefId: id,
  workspace: z.strictObject({
    issueId: text,
    path: text,
    key: text,
    branch: text,
    status: z.enum(["idle", "running", "done", "failed"]),
    createdAt: text,
  }),
  personas: z.array(personaSchema).min(2).max(20),
  verifyCommand: text,
  timeoutSec: z.number().int().min(1).max(86_400),
  maxRepairs: z.number().int().min(0).max(10),
  status: z.enum(["pending", "planning", "executing", "reviewing", "verifying", "completed", "failed"]),
  createdAt: text,
  updatedAt: text,
  oma: z.boolean().optional(),
  plan: planSchema.optional(),
  tasks: z
    .array(
      z.strictObject({
        id,
        reviewerId: id,
        status: z.enum(["pending", "running", "reviewing", "completed"]),
        attempts: counter,
        repairRound: counter.optional(),
        output: z.string().max(32_000).optional(),
        review: reviewSchema.optional(),
        fingerprint: text.optional(),
      }),
    )
    .max(12),
  finalReview: reviewSchema.optional(),
  verification: z
    .strictObject({ ok: z.boolean(), output: z.string().max(32_000).optional(), fingerprint: text })
    .optional(),
  history: z.array(z.strictObject({ at: text, stage: text, message: text, taskId: id.optional() })),
  error: text.optional(),
  fingerprint: text.optional(),
  initialFingerprint: text.optional(),
  repairRound: counter.optional(),
})

function parseJson(source: string, stage: string): unknown {
  if (source.length > 128_000) throw new Error(`${stage} response exceeds 128 KB. Return only the requested JSON.`)
  const content = source.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`${stage} response is not valid JSON. Return one JSON object matching the requested schema.`)
  }
}

export function validatePlan(plan: ChiefPlan, personas: Persona[]): void {
  const ids = new Set<string>()
  const personaIds = new Set(personas.map((persona) => persona.id))
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id ${task.id}. Give every plan task a unique id.`)
    ids.add(task.id)
    if (!personaIds.has(task.personaId))
      throw new Error(`Unknown persona ${task.personaId}. Assign a configured persona id.`)
  }
  const nodes: Record<string, DagNode> = Object.create(null)
  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency))
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}. Correct the plan.`)
    }
    if (new Set(task.dependencies).size !== task.dependencies.length) {
      throw new Error(`Task ${task.id} repeats a dependency. Remove duplicate dependencies.`)
    }
    nodes[task.id] = {
      issueId: task.id,
      identifier: task.id,
      status: "waiting",
      parentId: null,
      children: [],
      blockedBy: task.dependencies,
      blocks: [],
    }
  }
  if (detectCycles(nodes).length > 0) throw new Error("Chief plan contains a dependency cycle. Return an acyclic plan.")
}

export function parsePlan(source: string, personas: Persona[]): ChiefPlan {
  const plan = planSchema.parse(parseJson(source, "Planning"))
  validatePlan(plan, personas)
  return plan
}

export function parseReview(source: string): Review {
  return reviewSchema.parse(parseJson(source, "Review"))
}

export function validateMission(input: Mission): Mission {
  const mission = missionSchema.parse(input)
  const personas = new Map(mission.personas.map((persona) => [persona.id, persona]))
  if (personas.size !== mission.personas.length)
    throw new Error("Duplicate persona ids. Give every persona a unique id.")
  if (!personas.has(mission.chiefId))
    throw new Error("chiefId is not a configured persona. Set chiefId to a persona id.")
  if (!mission.plan && mission.tasks.length > 0)
    throw new Error("Mission has task state without a plan. Restore its saved plan.")
  if (mission.plan) {
    validatePlan(mission.plan, mission.personas)
    const tasks = new Map(mission.tasks.map((task) => [task.id, task]))
    if (tasks.size !== mission.tasks.length || tasks.size !== mission.plan.tasks.length) {
      throw new Error("Saved task state does not match the plan. Restore an intact mission state file.")
    }
    for (const task of mission.plan.tasks) {
      const state = tasks.get(task.id)
      if (!state || !personas.has(state.reviewerId) || state.reviewerId === task.personaId) {
        throw new Error(
          `Task ${task.id} needs a configured reviewer different from its worker. Correct the mission state.`,
        )
      }
      if (state.status === "completed" && (!state.review?.passed || !state.fingerprint)) {
        throw new Error(`Task ${task.id} lacks passing review evidence. Restore its mission state before resuming.`)
      }
    }
  }
  return mission
}
