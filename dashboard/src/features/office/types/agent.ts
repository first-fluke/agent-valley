export type WorkspaceStatus = "idle" | "running" | "done" | "failed"

export interface ActiveWorkspace {
  issueId: string
  key: string
  status: WorkspaceStatus
  startedAt: string
}

export interface OrchestratorState {
  isRunning: boolean
  lastEventAt: string | null
  activeWorkspaces: ActiveWorkspace[]
  activeAgents: number
  retryQueueSize: number
  config: {
    agentType: "claude" | "codex" | "gemini"
    maxParallel: number
    serverPort: number
  }
}

export type AgentType = "claude" | "codex" | "gemini"

export interface AgentVisual {
  type: AgentType
  workspace: ActiveWorkspace | null
}
