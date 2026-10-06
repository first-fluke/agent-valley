import { parseJson, validatePlan } from "./plan-validation"
import { validateOriginalAcceptance } from "./supervision-contract"

export { parseJson, validatePlan } from "./plan-validation"

export {
  parseSupervisionResponse,
  type SupervisionResponse,
  supervisionResponseSchema,
  validateOriginalAcceptance,
} from "./supervision-contract"

import {
  advisoryReviewSchema,
  refineChiefWaitSchedule,
  reviewSchema,
  supervisionSchema,
  taskStateSchema,
  verificationSchema,
} from "./mission-state-schema"

export { reviewSchema } from "./mission-state-schema"

import { isAbsolute } from "node:path"
import { z } from "zod"
import { actorSchema, actorTaskSchema } from "./actor-contract"
import { capturePolicySchema, captureResultSchema } from "./capture"
import { containerObservationPolicySchema, containerObservationSnapshotSchema } from "./container-observation-policy"
import { refineMissionContainerState } from "./container-observation-state"
import { CDO_ROLE } from "./design-lead"
import { executionPolicySchema, executionStateSchema } from "./execution"
import { validateFinalReview } from "./goal-evidence"
import { CMO_ROLE } from "./marketing-lead"
import { metricSourcePolicySchema } from "./metric-source-policy"
import { chiefOperatingPolicySchema, chiefOperationsSchema } from "./operations"
import { organizationContextSchema } from "./organization"
import { chiefReportSchema } from "./reports"
import { CTO_ROLE } from "./technical-lead"
import { toolEnvKeysSchema } from "./tool-environment"
import type { ChiefPlan, GoalBrief, Mission, Persona, Review } from "./types"
import {
  goalVerificationContractDigest,
  goalVerificationContractSchema,
  goalVerificationResultSchema,
  validateGoalVerificationContract,
  validateGoalVerificationResult,
} from "./verification"

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
const text = z.string().trim().min(1).max(32_000)
const counter = z.number().int().min(0)

export { actorSchema } from "./actor-contract"
export const personaSchema = actorSchema

export const goalBriefSchema = z.strictObject({
  interpretation: text,
  assumptions: z.array(text).max(20),
  successCriteria: z
    .array(text)
    .min(1)
    .max(20)
    .refine((criteria) => new Set(criteria).size === criteria.length, "Success criteria must be unique."),
})

const skillDescriptorSchema = z.strictObject({
  name: z.string().regex(/^oma-[a-z0-9][a-z0-9-]{0,123}$/),
  description: z.string().trim().min(1).max(1_000),
  path: text.refine(isAbsolute, "Skill paths must be absolute verified SKILL.md paths."),
})

export const planSchema = z.strictObject({
  tasks: z.array(actorTaskSchema).min(1).max(12),
})

export const missionSchema = z
  .strictObject({
    id,
    repositoryRoot: text.refine(isAbsolute, "Original repository root must be absolute.").optional(),
    toolEnvKeys: toolEnvKeysSchema.optional(),
    goal: text,
    chiefId: id,
    technicalLeadId: id.optional(),
    technicalReview: advisoryReviewSchema.optional(),
    designLeadId: id.optional(),
    designReview: advisoryReviewSchema.optional(),
    marketingLeadId: id.optional(),
    marketingReview: advisoryReviewSchema.optional(),
    workspace: z.strictObject({
      issueId: text,
      path: text,
      key: text,
      branch: text,
      status: z.enum(["idle", "running", "done", "failed"]),
      createdAt: text,
    }),
    personas: z.array(personaSchema).min(2).max(20),
    availableAgents: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/))
      .min(1)
      .max(20)
      .optional(),
    availableSkills: z.array(skillDescriptorSchema).max(100).optional(),
    goalBrief: goalBriefSchema.optional(),
    supervision: supervisionSchema.optional(),
    report: chiefReportSchema.optional(),
    verifyCommand: z.string().trim().max(32_000),
    timeoutSec: z.number().int().min(1).max(86_400),
    maxRepairs: z.number().int().min(0).max(10),
    status: z.enum([
      "pending",
      "planning",
      "executing",
      "reviewing",
      "verifying",
      "waiting",
      "paused",
      "completed",
      "failed",
    ]),
    createdAt: text,
    updatedAt: text,
    oma: z.boolean().optional(),
    plan: planSchema.optional(),
    tasks: z.array(taskStateSchema).max(12),
    finalReview: reviewSchema.optional(),
    verification: verificationSchema.optional(),
    history: z.array(z.strictObject({ at: text, stage: text, message: text, taskId: id.optional() })),
    error: text.optional(),
    fingerprint: text.optional(),
    initialFingerprint: text.optional(),
    repairRound: counter.optional(),
    operatingPolicy: chiefOperatingPolicySchema.optional(),
    operations: chiefOperationsSchema.optional(),
    organizationContext: organizationContextSchema.optional(),
    capturePolicy: capturePolicySchema.optional(),
    capture: captureResultSchema.optional(),
    verificationMode: z.enum(["chief", "operator"]).optional(),
    verificationContract: goalVerificationContractSchema.optional(),
    verificationContractSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    goalVerification: goalVerificationResultSchema.optional(),
    executionPolicy: executionPolicySchema.optional(),
    execution: executionStateSchema.optional(),
    metricSourcePolicy: metricSourcePolicySchema.optional(),
    observationStartedAt: z.iso.datetime().optional(),
    metricBaselineIds: z.record(z.string().min(1).max(120), z.string().min(1).max(120)).optional(),
    containerObservationPolicy: containerObservationPolicySchema.optional(),
    containerObservation: containerObservationSnapshotSchema.optional(),
    containerObservationVerifiedFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .superRefine((mission, ctx) => {
    refineMissionContainerState(mission, ctx)
    refineChiefWaitSchedule(mission, ctx)
    if (!mission.verifyCommand.trim() && mission.verificationMode !== "chief")
      ctx.addIssue({
        code: "custom",
        path: ["verifyCommand"],
        message: "Set an operator verification command or select Chief-generated verification.",
      })
  })

export function parsePlan(source: string, personas: Persona[]): ChiefPlan {
  const plan = planSchema.parse(parseJson(source, "Planning"))
  validatePlan(plan, personas)
  return plan
}

export function parsePlanningResponse(
  source: string,
  mission: Mission,
): {
  personas: Persona[]
  plan: ChiefPlan
  goalBrief?: GoalBrief
  verificationContract?: import("./verification-contract").GoalVerificationContract
} {
  if (!mission.availableAgents && !mission.supervision)
    return { personas: mission.personas, plan: parsePlan(source, mission.personas) }
  if (source.length > 8_000)
    throw new Error(
      "Planning response exceeds 8,000 characters. Return a concise roster and plan within the transport limit.",
    )
  const roster = mission.availableAgents
    ? z
        .array(actorSchema)
        .min(
          Math.max(
            2,
            1 + [mission.technicalLeadId, mission.designLeadId, mission.marketingLeadId].filter(Boolean).length,
          ),
        )
        .max(8)
        .optional()
    : z.never().optional()
  const response = z
    .strictObject({
      actors: roster,
      personas: roster,
      tasks: planSchema.shape.tasks,
      goalBrief: mission.supervision ? goalBriefSchema : z.never().optional(),
      verificationContract:
        mission.verificationMode === "chief"
          ? goalVerificationContractSchema
          : goalVerificationContractSchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (mission.availableAgents && !input.actors && !input.personas)
        ctx.addIssue({ code: "custom", path: ["actors"], message: "Return the generated Actor roster in actors." })
      if (input.actors && input.personas)
        ctx.addIssue({ code: "custom", path: ["actors"], message: "Return actors or legacy Actors, not both rosters." })
    })
    .parse(parseJson(source, "Planning"))
  const personas = response.actors ?? response.personas ?? mission.personas
  if (mission.availableAgents) validateAutomaticPersonas(personas, mission, true)
  const plan: ChiefPlan = { tasks: response.tasks }
  validatePlan(plan, personas)
  const chief = mission.personas.find((persona) => persona.id === mission.chiefId)
  const generatedChief = personas.find((persona) => persona.id === mission.chiefId)
  if (chief?.model && generatedChief) generatedChief.model = chief.model
  if (response.verificationContract)
    validateGoalVerificationContract(response.verificationContract, response.goalBrief?.successCriteria ?? [])
  return {
    personas,
    plan,
    ...(response.goalBrief ? { goalBrief: response.goalBrief } : {}),
    ...(response.verificationContract ? { verificationContract: response.verificationContract } : {}),
  }
}

function validateAutomaticPersonas(personas: Persona[], mission: Mission, planning = false): void {
  if (mission.technicalLeadId === mission.chiefId)
    throw new Error(
      "The permanent Technical Director must be a different Actor from the Chief Director. Restore technicalLeadId.",
    )
  if (
    mission.designLeadId &&
    (mission.designLeadId === mission.chiefId || mission.designLeadId === mission.technicalLeadId)
  )
    throw new Error(
      "The permanent Design Director must be different from the Chief Director and Technical Director. Restore designLeadId.",
    )
  if (
    mission.marketingLeadId &&
    [mission.chiefId, mission.technicalLeadId, mission.designLeadId].includes(mission.marketingLeadId)
  )
    throw new Error(
      "The permanent Marketing Director must be different from the Chief Director, Technical Director and Design Director. Restore marketingLeadId.",
    )
  const ids = new Set(personas.map((persona) => persona.id))
  if (ids.size !== personas.length) throw new Error("Duplicate Actor ids. Give every generated Actor a unique id.")
  if (!ids.has(mission.chiefId))
    throw new Error(`Generated Actors omit chiefId ${mission.chiefId}. Keep the Chief Director in the mission roster.`)
  if (mission.technicalLeadId && !ids.has(mission.technicalLeadId))
    throw new Error(
      `Generated Actors omit technicalLeadId ${mission.technicalLeadId}. Keep the Chief Director's Technical Director companion in the roster.`,
    )
  if (mission.designLeadId && !ids.has(mission.designLeadId))
    throw new Error(
      `Generated Actors omit designLeadId ${mission.designLeadId}. Keep the Chief Director's Design Director companion in the roster.`,
    )
  if (mission.marketingLeadId && !ids.has(mission.marketingLeadId))
    throw new Error(
      `Generated Actors omit marketingLeadId ${mission.marketingLeadId}. Keep the Chief Director's Marketing Director companion in the roster.`,
    )
  const selectedChief = mission.personas.find((persona) => persona.id === mission.chiefId)
  if (planning && !selectedChief)
    throw new Error("The selected Chief Director is missing. Restore its configured Actor before planning.")
  for (const persona of personas) {
    if (!mission.availableAgents?.includes(persona.agentType)) {
      throw new Error(`Unavailable Actor type ${persona.agentType}. Select only a supplied availableActors CLI.`)
    }
    if (planning && persona.id === mission.chiefId && persona.agentType !== selectedChief?.agentType)
      throw new Error(`Chief Director ${mission.chiefId} must keep the selected actorType ${selectedChief?.agentType}.`)
    if (persona.model !== undefined && (planning || persona.id !== mission.chiefId))
      throw new Error(
        "Automatic Actors cannot set model identifiers. Omit model; only the operator's selected Chief Director model is retained.",
      )
    if (persona.skills.some((name) => !mission.availableSkills?.some((skill) => skill.name === name)))
      throw new Error(
        "Automatic Actors cannot attach unverified skills. Select installed availableSkills names or return skills: [].",
      )
  }
  const cto = personas.find((entry) => entry.id === mission.technicalLeadId)
  if (cto) cto.role = CTO_ROLE
  const cdo = personas.find((entry) => entry.id === mission.designLeadId)
  if (cdo) cdo.role = CDO_ROLE
  const cmo = personas.find((entry) => entry.id === mission.marketingLeadId)
  if (cmo) cmo.role = CMO_ROLE
}

export function parseReview(source: string): Review {
  return reviewSchema.parse(parseJson(source, "Review"))
}

export { finalCriteria } from "./goal-evidence"

export function parseFinalReview(source: string, mission: Mission): Review {
  return validateFinalReview(parseReview(source), mission)
}

export function validateMission(input: Mission): Mission {
  const mission = missionSchema.parse(input)
  if (mission.plan && mission.verificationMode === "chief" && !mission.verificationContract)
    throw new Error("Chief verification is missing its immutable checks. Restore the saved verification contract.")
  if (mission.verificationContract)
    validateGoalVerificationContract(mission.verificationContract, mission.goalBrief?.successCriteria ?? [])
  if (
    mission.verificationContract &&
    mission.verificationContractSha256 !== goalVerificationContractDigest(mission.verificationContract)
  )
    throw new Error("Saved verification contract does not match its immutable digest. Restore the original checks.")
  if (mission.goalVerification && mission.verificationContract)
    validateGoalVerificationResult(mission.goalVerification, mission.verificationContract)
  const personas = new Map(mission.personas.map((persona) => [persona.id, persona]))
  if (personas.size !== mission.personas.length) throw new Error("Duplicate Actor ids. Give every Actor a unique id.")
  if (!personas.has(mission.chiefId)) throw new Error("chiefId is not a configured Actor. Set chiefId to an Actor id.")
  if (
    mission.technicalLeadId &&
    (!personas.has(mission.technicalLeadId) || mission.technicalLeadId === mission.chiefId)
  )
    throw new Error(
      "technicalLeadId must name a configured Technical Director Actor different from the Chief Director. Restore the permanent Technical Director companion.",
    )
  if (mission.technicalReview && mission.technicalReview.reviewerId !== mission.technicalLeadId)
    throw new Error(
      "Saved technical advice belongs to another Actor. Restore the nominated Technical Director reviewer.",
    )
  if (
    mission.designLeadId &&
    (!personas.has(mission.designLeadId) ||
      mission.designLeadId === mission.chiefId ||
      mission.designLeadId === mission.technicalLeadId)
  )
    throw new Error(
      "designLeadId must name a configured Design Director different from the Chief Director and Technical Director. Restore the permanent Design Director companion.",
    )
  if (mission.designReview && mission.designReview.reviewerId !== mission.designLeadId)
    throw new Error("Saved design advice belongs to another Actor. Restore the nominated Design Director reviewer.")
  if (
    mission.marketingLeadId &&
    (!personas.has(mission.marketingLeadId) ||
      [mission.chiefId, mission.technicalLeadId, mission.designLeadId].includes(mission.marketingLeadId))
  )
    throw new Error(
      "marketingLeadId must name a configured Marketing Director different from the Chief Director, Technical Director and Design Director. Restore the permanent Marketing Director companion.",
    )
  if (mission.marketingReview && mission.marketingReview.reviewerId !== mission.marketingLeadId)
    throw new Error(
      "Saved marketing advice belongs to another Actor. Restore the nominated Marketing Director reviewer.",
    )
  if (mission.availableAgents) {
    if (new Set(mission.availableAgents).size !== mission.availableAgents.length)
      throw new Error("Duplicate available Actor types. List each available CLI once.")
    validateAutomaticPersonas(mission.personas, mission)
  }
  if (
    mission.availableSkills &&
    new Set(mission.availableSkills.map((skill) => skill.name)).size !== mission.availableSkills.length
  )
    throw new Error("Duplicate available skill names. Restore the verified installed skill catalog before resuming.")
  if (mission.supervision) {
    const supervision = mission.supervision
    if (supervision.rounds > supervision.maxRounds || supervision.stalledRounds > supervision.rounds)
      throw new Error("Invalid persisted supervision budget. Restore its original rounds and limits before resuming.")
    if (supervision.operatorGoal !== undefined && supervision.operatorGoal !== mission.goal)
      throw new Error("The operator's goal changed. Restore the saved original goal before resuming.")
    if (supervision.operatorVerifyCommand !== undefined && supervision.operatorVerifyCommand !== mission.verifyCommand)
      throw new Error(
        "The operator's verification command changed. Restore the saved acceptance command before resuming.",
      )
    if (mission.plan && (!mission.goalBrief || !supervision.originalAcceptance))
      throw new Error(
        "Goal supervision is missing its original goal brief or acceptance obligations. Restore the mission checkpoint.",
      )
    if (mission.plan) validateOriginalAcceptance(mission.plan, mission)
    let previousRound = 0
    for (const decision of supervision.decisions) {
      if (decision.round <= previousRound || decision.round > supervision.rounds)
        throw new Error("Invalid saved Chief Director decision order. Restore the supervision checkpoint.")
      previousRound = decision.round
    }
    if (
      supervision.pendingRecovery?.taskId &&
      !mission.plan?.tasks.some((task) => task.id === supervision.pendingRecovery?.taskId)
    )
      throw new Error("Pending Chief Director recovery refers to a missing task. Restore the saved mission plan.")
  }
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
          `Task ${task.id} needs a configured reviewer different from its Actor. Correct the mission state.`,
        )
      }
      if (state.status === "completed" && (!state.review?.passed || !state.fingerprint)) {
        throw new Error(`Task ${task.id} lacks passing review evidence. Restore its mission state before resuming.`)
      }
    }
  }
  if (mission.supervision && mission.finalReview) parseFinalReview(JSON.stringify(mission.finalReview), mission)
  return mission
}
