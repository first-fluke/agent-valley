import type { Workspace } from "../domain/models"
import type { CapturePolicy, CaptureResult } from "./capture"
import type { ExecutionPolicy, ExecutionState } from "./execution"
import type { MetricSourcePolicy } from "./metric-source-policy"
import type { ChiefOperatingPolicy, ChiefOperations } from "./operations"
import type { OrganizationContext } from "./organization"
import type { ChiefReport } from "./reports"
import type { SkillDescriptor } from "./skills"
import type { GoalVerificationContract, GoalVerificationResult } from "./verification"

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
  parallel?: import("./parallel-workspace").TaskWorktreeRecord
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
  | "final-review"
  | "supervise"
  | "report"

export interface Mission {
  id: string
  repositoryRoot?: string
  /** Explicit tool credential names; values are resolved only in the Actor subprocess environment. */
  toolEnvKeys?: string[]
  goal: string
  chiefId: string
  technicalLeadId?: string
  technicalReview?: AdvisoryReview
  designLeadId?: string
  designReview?: AdvisoryReview
  marketingLeadId?: string
  marketingReview?: AdvisoryReview
  workspace: Workspace
  personas: Persona[]
  /** Available CLI types for goal-specific roster planning; absent for supplied or legacy rosters. */
  availableAgents?: string[]
  availableSkills?: SkillDescriptor[]
  goalBrief?: GoalBrief
  supervision?: MissionSupervision
  report?: ChiefReport
  verifyCommand: string
  timeoutSec: number
  maxRepairs: number
  status: MissionStatus
  createdAt: string
  updatedAt: string
  oma?: boolean
  plan?: ChiefPlan
  tasks: ChiefTaskState[]
  finalReview?: Review
  verification?: Verification
  history: MissionEvent[]
  error?: string
  fingerprint?: string
  initialFingerprint?: string
  repairRound?: number
  operatingPolicy?: ChiefOperatingPolicy
  operations?: ChiefOperations
  organizationContext?: OrganizationContext
  capturePolicy?: CapturePolicy
  capture?: CaptureResult
  verificationMode?: "chief" | "operator"
  verificationContract?: GoalVerificationContract
  verificationContractSha256?: string
  goalVerification?: GoalVerificationResult
  executionPolicy?: ExecutionPolicy
  execution?: ExecutionState
  metricSourcePolicy?: MetricSourcePolicy
  observationStartedAt?: string
  metricBaselineIds?: Record<string, string>
}

export interface GoalBrief {
  interpretation: string
  assumptions: string[]
  successCriteria: string[]
}

export interface SupervisionDecision {
  round: number
  at: string
  action: "repair" | "reassign" | "replan" | "stop"
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

export interface ChiefPorts {
  runAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal },
  ): Promise<string>
  verify(mission: Mission): Promise<{ ok: boolean; output?: string }>
  save(mission: Mission): Promise<void>
  fingerprint(mission: Mission): Promise<string>
  refreshOrganization?(mission: Mission): Promise<OrganizationContext>
  observeMetrics?(
    mission: Mission,
  ): Promise<{ status: "satisfied" | "waiting" | "failed"; reason: string; nextPollAt?: string }>
  parallel?: {
    prepare(
      mission: Mission,
      taskId: string,
      attempt: number,
    ): Promise<import("./parallel-workspace").TaskWorktreeRecord>
    integrate(mission: Mission, record: import("./parallel-workspace").TaskWorktreeRecord): Promise<void>
    dispose(record: import("./parallel-workspace").TaskWorktreeRecord): Promise<void>
  }
  signal?: AbortSignal
}
