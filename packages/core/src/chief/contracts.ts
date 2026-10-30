/**
 * Chief leaf contracts.
 *
 * Types here MUST NOT import feature modules (capture, execution, reports,
 * review-gates, …). Feature modules import from this file, and `types.ts`
 * composes them into `Mission`; this keeps the dependency direction one-way
 * and removes the former `types.ts` import cycle.
 */
import { z } from "zod"
import type { TaskWorktreeRecord } from "./parallel-contract"

// ── Roster / plan / review ───────────────────────────────────────────────────

export interface Actor {
  id: string
  name: string
  role: string
  agentType: string
  model?: string
  skills: string[]
}

/** Legacy persisted missions and native adapters keep their existing fields. */
export type Persona = Actor

export interface ChiefTask {
  id: string
  title: string
  personaId: string
  instructions: string
  acceptance: string[]
  dependencies: string[]
  effectScope?: "workspace" | "external"
}

export interface ChiefPlan {
  tasks: ChiefTask[]
}

export interface Review {
  passed: boolean
  summary: string
  findings: string[]
  criteria?: { criterion: string; passed: boolean; evidence: string }[]
}

export interface ChiefTaskState {
  id: string
  reviewerId: string
  status: "pending" | "running" | "reviewing" | "completed"
  attempts: number
  repairRound?: number
  output?: string
  review?: Review
  fingerprint?: string
  effectState?: "not-started" | "running" | "unknown" | "completed"
  parallel?: TaskWorktreeRecord
}

export interface MissionEvent {
  at: string
  stage: string
  message: string
  taskId?: string
}

export interface Verification {
  ok: boolean
  output?: string
  fingerprint: string
}

export interface AdvisoryReview {
  planKey: string
  reviewerId: string
  fingerprint: string
  review: Review
}

export type MissionStatus =
  | "pending"
  | "planning"
  | "executing"
  | "reviewing"
  | "verifying"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"

export type ChiefStage =
  | "plan"
  | "technical-review"
  | "design-review"
  | "marketing-review"
  | "work"
  | "review"
  | "gate-review"
  | "final-review"
  | "supervise"
  | "report"

export interface GoalBrief {
  interpretation: string
  assumptions: string[]
  successCriteria: string[]
}

export interface SupervisionDecision {
  round: number
  at: string
  action: "repair" | "reassign" | "replan" | "stop" | "wait"
  retryAfterSec?: number
  reason: string
  fingerprint: string
  taskId?: string
  personaId?: string
  instructions?: string
  previousTasks?: ChiefTaskState[]
  evidence?: { finalReview?: Review; verification?: Verification }
}

export interface MissionSupervision {
  maxRounds: number
  rounds: number
  stalledRounds: number
  lastFingerprint?: string
  decisions: SupervisionDecision[]
  originalAcceptance?: string[]
  operatorGoal?: string
  operatorVerifyCommand?: string
  pendingRecovery?: { reason: string; taskId?: string }
}

// ── Execution policy/state ───────────────────────────────────────────────────

export const executionPolicySchema = z.strictObject({
  maxParallel: z.number().int().min(1).max(8).default(3),
  maxDurationSec: z.number().int().min(1).max(604_800).default(86_400),
  maxRuns: z.number().int().min(1).max(2_000).default(200),
  maxEstimatedCostUsd: z.number().finite().positive().optional(),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryDelayMs: z.number().int().min(10).max(300_000).default(1_000),
  autoResume: z.boolean().default(true),
})
export type ExecutionPolicy = z.infer<typeof executionPolicySchema>

export const executionStateSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  runsStarted: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  crashRestarts: z.number().int().nonnegative().optional(),
  nextRunAt: z.iso.datetime().optional(),
  pauseReason: z.string().max(32_000).optional(),
  failureKind: z
    .enum([
      "authentication",
      "rate-limit",
      "provider",
      "environment",
      "implementation",
      "unknown-effect",
      "budget",
      "interrupted",
      "service-shutdown",
      "chief-wait",
      "chief-unavailable",
      "integrity",
    ])
    .optional(),
  progressKey: z.string().optional(),
  interventionAt: z.iso.datetime().optional(),
  costReconciliations: z
    .array(
      z.strictObject({
        runId: z.string().min(1).max(2_000),
        costUsd: z.number().finite().nonnegative(),
        at: z.iso.datetime(),
        authority: z.literal("operator-recorded"),
      }),
    )
    .max(2_000)
    .optional(),
})
export type ExecutionState = z.infer<typeof executionStateSchema>
export type FailureKind = NonNullable<ExecutionState["failureKind"]>

// ── Report / gate output ─────────────────────────────────────────────────────

export interface ChiefReport {
  summary: string
  eli5: string
  goalAssessment: string
  assumptions: string[]
  decisions: string[]
  deliverables: string[]
  checks: string[]
  remaining: string[]
}

/**
 * Structural mirror of `gateReviewSchema` in `review-gates.ts`. The schema
 * stays with its validation logic; this interface lets `Mission` depend on a
 * leaf type instead of the module that imports `Mission`.
 */
export interface GateReview {
  gateId: string
  taskId: string
  reviewerId: string
  fingerprint: string
  review: Review
}
