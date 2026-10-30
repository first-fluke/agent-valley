import type { Workspace } from "../domain/models"
import type { CapturePolicy, CaptureResult } from "./capture"
import type { CodeDelivery } from "./code-delivery-contract"
import type { ContainerObservationPolicy, ContainerObservationSnapshot } from "./container-observation-policy"
import type {
  AdvisoryReview,
  ChiefPlan,
  ChiefReport,
  ChiefStage,
  ChiefTaskState,
  ExecutionPolicy,
  ExecutionState,
  GateReview,
  GoalBrief,
  MissionStatus,
  MissionSupervision,
  Persona,
  Review,
  Verification,
} from "./contracts"
import type { MetricSourcePolicy } from "./metric-source-policy"
import type { PreparedOmaActor } from "./oma-actor"
import type { ChiefOperatingPolicy, ChiefOperations } from "./operations"
import type { OrganizationContext } from "./organization-types"
import type { SkillDescriptor } from "./skills"
import type { GoalVerificationContract, GoalVerificationResult } from "./verification"

// Compatibility surface: consumers can keep importing leaf types from
// `chief/types`, while feature modules depend on `chief/contracts` directly.
export * from "./contracts"

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
  codeDelivery?: CodeDelivery
  verifyCommand: string
  timeoutSec: number
  maxRepairs: number
  status: MissionStatus
  createdAt: string
  updatedAt: string
  oma?: boolean
  plan?: ChiefPlan
  tasks: ChiefTaskState[]
  gateReviews?: GateReview[]
  gateReviewRefreshes?: number
  finalReview?: Review
  verification?: Verification
  history: import("./contracts").MissionEvent[]
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
  containerObservationPolicy?: ContainerObservationPolicy
  containerObservation?: ContainerObservationSnapshot
  containerObservationVerifiedFingerprint?: string
}

export interface ChiefPorts {
  /** Validate and bind required OMA inputs before reserving a run or dispatching an external effect. */
  prepareWork?(
    persona: Persona,
    mission: Mission,
    context?: { workspace?: Workspace; signal?: AbortSignal },
  ): Promise<PreparedOmaActor | undefined>
  runAgent(
    persona: Persona,
    prompt: string,
    mission: Mission,
    stage: ChiefStage,
    context?: { taskId?: string; workspace?: Workspace; signal?: AbortSignal; omaActor?: PreparedOmaActor },
  ): Promise<string>
  verify(mission: Mission): Promise<{ ok: boolean; output?: string }>
  save(mission: Mission): Promise<void>
  fingerprint(mission: Mission): Promise<string>
  refreshOrganization?(mission: Mission): Promise<OrganizationContext>
  observeMetrics?(
    mission: Mission,
  ): Promise<{ status: "satisfied" | "waiting" | "failed"; reason: string; nextPollAt?: string }>
  observeContainers?(mission: Mission): Promise<ContainerObservationSnapshot>
  parallel?: {
    prepare(
      mission: Mission,
      taskId: string,
      attempt: number,
    ): Promise<import("./parallel-contract").TaskWorktreeRecord>
    integrate(mission: Mission, record: import("./parallel-contract").TaskWorktreeRecord): Promise<void>
    dispose(record: import("./parallel-contract").TaskWorktreeRecord): Promise<void>
  }
  signal?: AbortSignal
}
