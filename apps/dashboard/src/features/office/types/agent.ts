import type { AgentType } from "@agent-valley/core/domain/ledger"
import type { RetryEntry, WaitingEntry } from "@agent-valley/core/domain/models"

export type { AgentType } from "@agent-valley/core/domain/ledger"

export type WorkspaceStatus = "idle" | "running" | "done" | "failed"

export interface ActiveWorkspace {
  issueId: string
  key: string
  status: WorkspaceStatus
  startedAt: string
  lastOutput?: string
  attemptId?: string
  agentType?: AgentType
}

export interface SystemMetrics {
  memoryRss: number
  memoryTotal: number
  cpuUser: number
  uptime: number
}

export interface OrchestratorState {
  isRunning: boolean
  lastEventAt: string | null
  activeWorkspaces: ActiveWorkspace[]
  activeAgents: number
  retryQueueSize: number
  waitingIssues?: number
  waitingIssueDetails?: WaitingEntry[]
  retryQueue?: RetryEntry[]
  config: {
    agentType: AgentType
    maxParallel: number
    serverPort: number
  }
  systemMetrics?: SystemMetrics
}

export type CharacterSkin = "default" | "ponytail" | "plumber" | "glasses" | "mohawk"

export const CHARACTER_SKINS: CharacterSkin[] = ["default", "ponytail", "plumber", "glasses", "mohawk"]

export interface AgentVisual {
  type: AgentType
  workspace: ActiveWorkspace | null
}
