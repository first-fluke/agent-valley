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
import type { HandoffState } from "./handoff-contract"
import type { MetricSourcePolicy } from "./metric-source-policy"
import type { PreparedOmaActor } from "./oma-actor"
import type { ChiefOperatingPolicy, ChiefOperations } from "./operations"
import type { OrganizationContext } from "./organization-types"
import type { ParallelBaseline, TaskChangeSet } from "./parallel-contract"
import type { SkillDescriptor } from "./skills"
import type {
  GoalVerificationContract,
  GoalVerificationResult,
  IntegrationEvidence,
  VerificationBaseline,
} from "./verification"

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
  /** The Chief's goal reviews taken before a final wave started; newest last. */
  goalGapReviews?: import("./contracts").GoalGapReview[]
  verification?: Verification
  history: import("./contracts").MissionEvent[]
  /** Operator notes recorded with `--note` on resume; newest last. */
  operatorNotes?: import("./contracts").OperatorNote[]
  /** Success criteria the operator accepted as unmet with `--waive-criterion` on resume. */
  criterionWaivers?: import("./contracts").CriterionWaiver[]
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
  /** Passing contract commands from the latest integration check; see `IntegrationEvidence`. */
  integrationEvidence?: IntegrationEvidence
  /** Passing contract commands from the latest fully passing goal verification; see `VerificationBaseline`. */
  verificationBaseline?: VerificationBaseline
  executionPolicy?: ExecutionPolicy
  execution?: ExecutionState
  handoff?: HandoffState
  metricSourcePolicy?: MetricSourcePolicy
  observationStartedAt?: string
  metricBaselineIds?: Record<string, string>
  containerObservationPolicy?: ContainerObservationPolicy
  containerObservation?: ContainerObservationSnapshot
  containerObservationVerifiedFingerprint?: string
}

export interface ChiefRunContext {
  taskId?: string
  workspace?: Workspace
  signal?: AbortSignal
  omaActor?: PreparedOmaActor
  handoff?: string
  /** Invoke claim synchronously after reserving a call, before awaiting its durable checkpoint. */
  beforeDispatch?: (claim: () => void) => Promise<void>
}

export interface IntegrationCheckContext {
  /** Code tasks whose integrated deliveries are being checked in this wave. */
  taskIds: readonly string[]
  /**
   * Sorted union of AV-computed changed relative paths across `taskIds`.
   * Undefined when any target lacks an AV changeSet, signaling runners to run the full suite.
   */
  changedFiles?: readonly string[]
  /** Code tasks in this mission that have not yet completed outside the current wave (0 on final wave). */
  openCodeTasks: number
}

export interface ChiefPorts {
  /** The native runtime admits the actual route before reserving a model call. */
  deferredDispatchAdmission?: boolean
  /** Probe supported local CLI installation and authentication; never starts a model run. */
  discoverReadyAgents?(): Promise<string[]>
  /** Read native catalog metadata; never probes availability by starting a model run. */
  discoverFreeModels?(
    agentType: string,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<{ models: string[]; defaultModel?: string }>
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
    context?: ChiefRunContext,
  ): Promise<string>
  verify(mission: Mission): Promise<{ ok: boolean; output?: string }>
  /**
   * Run the verification contract's command checks on the integrated tree between task waves. The result is
   * evidence for task reviewers, never a completion verdict. Undefined when there is nothing to run.
   */
  integrationCheck?(
    mission: Mission,
    context?: IntegrationCheckContext,
  ): Promise<{ ok: boolean; output: string } | undefined>
  /**
   * Run the operator's quick pre-delivery command in the workspace an Actor just returned from (its isolated
   * wave workspace or the mission workspace), before the work waits for an integration check and a review.
   * Resolves to undefined when no command is configured.
   */
  preDeliveryCheck?(
    mission: Mission,
    workspacePath: string,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; output: string } | undefined>
  save(mission: Mission): Promise<void>
  fingerprint(mission: Mission): Promise<string>
  refreshOrganization?(mission: Mission): Promise<OrganizationContext>
  observeMetrics?(
    mission: Mission,
  ): Promise<{ status: "satisfied" | "waiting" | "failed"; reason: string; nextPollAt?: string }>
  observeContainers?(mission: Mission): Promise<ContainerObservationSnapshot>
  /**
   * Capture the git tree SHA of a workspace using a safe temporary index, respecting ignore rules.
   * Resolves to undefined when the workspace is not a git repository or tree capture fails.
   */
  captureWorkspaceTree?(workspacePath: string): Promise<string | undefined>
  /**
   * Compute a standard TaskChangeSet between an input tree and the workspace's delivered tree.
   * Resolves to undefined when diffing or tree capture fails.
   */
  collectDirectChangeSet?(
    workspacePath: string,
    inputTree: string,
    deliveryTree?: string,
  ): Promise<TaskChangeSet | undefined>
  parallel?: {
    /** Capture and validate one shared wave baseline snapshot so concurrent lane preparations reuse it. */
    prepareBaseline?(mission: Mission): Promise<ParallelBaseline>
    prepare(
      mission: Mission,
      taskId: string,
      attempt: number,
      baseline?: ParallelBaseline,
    ): Promise<import("./parallel-contract").TaskWorktreeRecord>
    integrate(mission: Mission, record: import("./parallel-contract").TaskWorktreeRecord): Promise<void>
    dispose(record: import("./parallel-contract").TaskWorktreeRecord): Promise<void>
    /**
     * Reclaim disposable Actor workspaces whose delivery.json status is `"applied"` immediately
     * after wave integration and checkpointing, leaving delivery receipts and git evidence intact.
     */
    reclaimApplied?(mission: Mission): Promise<{
      released: string[]
      retained: string[]
      errors?: Array<{ path: string; message: string }>
    }>
  }
  /** Release disposable storage (applied Actor repositories, ignored build output) after the mission completes. */
  releaseStorage?(mission: Mission): Promise<void>
  signal?: AbortSignal
}
