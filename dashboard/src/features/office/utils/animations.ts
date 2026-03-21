import type { WorkspaceStatus } from "@/features/office/types/agent"

export interface AnimationConfig {
  name: string
  frameCount: number
  speed: number
  loop: boolean
}

export const STATE_ANIMATION_MAP: Record<WorkspaceStatus, AnimationConfig> = {
  idle: { name: "sit_coffee", frameCount: 2, speed: 0.5, loop: true },
  running: { name: "typing", frameCount: 4, speed: 1.5, loop: true },
  done: { name: "celebrate", frameCount: 3, speed: 0.8, loop: true },
  failed: { name: "error_scratch", frameCount: 3, speed: 0.6, loop: true },
}
