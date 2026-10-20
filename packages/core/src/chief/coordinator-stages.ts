import type { createMissionCheckpoint } from "./coordinator-checkpoint"
import type { createChiefRecovery } from "./coordinator-recovery"
import type { createMissionReporter } from "./coordinator-report"
import type { createMissionRun } from "./coordinator-run"
import type { createMissionContract } from "./coordinator-state"
import type { ChiefPorts, Mission, Persona } from "./types"

export type CoordinatorStage = "resume" | "planning" | "tasks" | "review-gates" | "verification" | "approval" | "report"
export type StageTransition = { kind: "next"; stage: CoordinatorStage } | { kind: "return" }

export interface CoordinatorContext {
  mission: Mission
  ports: ChiefPorts
  operatorGoal: string
  operatorVerify: string
  contract: ReturnType<typeof createMissionContract>
  checkpoint: ReturnType<typeof createMissionCheckpoint>
  run: ReturnType<typeof createMissionRun>
  generateReport: ReturnType<typeof createMissionReporter>
  requestRecovery: ReturnType<typeof createChiefRecovery>
  requestRepair(reason: string): Promise<void>
  persona(id: string): Persona
  save(stage: string, message: string, taskId?: string): Promise<void>
  assertContract(): void
  checkAbort(): void
  protectedFailure(error: unknown): boolean
  invalidate(): void
}
