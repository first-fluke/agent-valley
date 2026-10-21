/** Shared Mission API dependency contract (leaf module breaking mission-api ↔ operation-api). */
import type { OrderOptions } from "./chief-config"
import type { JobLiveness, MissionJob } from "./mission-jobs"
import type { MissionLaunch } from "./mission-launcher"

export interface MissionApiDependencies {
  launch?: (input: MissionLaunch) => Promise<{ pid: number; identity?: string }>
  liveness?: (job: MissionJob) => JobLiveness
  signal?: (pid: number) => void
  validateOrder?: (workspace: string, options: OrderOptions) => Promise<unknown>
  env?: NodeJS.ProcessEnv
}
