import type { Workspace } from "../domain/models"

export interface Persona {
  id: string
  name: string
  role: string
  agentType: string
  model?: string
  skills: string[]
}

export interface ChiefTask {
  id: string
  title: string
  personaId: string
  instructions: string
  acceptance: string[]
  dependencies: string[]
}

export interface ChiefPlan {
  tasks: ChiefTask[]
}

export interface Review {
  passed: boolean
  summary: string
  findings: string[]
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

export type MissionStatus = "pending" | "planning" | "executing" | "reviewing" | "verifying" | "completed" | "failed"
export type ChiefStage = "plan" | "work" | "review" | "final-review"

export interface Mission {
  id: string
  goal: string
  chiefId: string
  workspace: Workspace
  personas: Persona[]
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
}

export interface ChiefPorts {
  runAgent(persona: Persona, prompt: string, mission: Mission, stage: ChiefStage): Promise<string>
  verify(mission: Mission): Promise<{ ok: boolean; output?: string }>
  save(mission: Mission): Promise<void>
  fingerprint(mission: Mission): Promise<string>
  signal?: AbortSignal
}
