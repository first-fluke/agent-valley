export type WorkspaceStatus = "idle" | "running" | "done" | "failed"

export interface ActiveWorkspace {
  issueId: string
  key: string
  status: WorkspaceStatus
  startedAt: string
  lastOutput?: string
}

export interface OrchestratorState {
  isRunning: boolean
  lastEventAt: string | null
  activeWorkspaces: ActiveWorkspace[]
  activeAgents: number
  retryQueueSize: number
  config: {
    agentType: AgentType
    maxParallel: number
    serverPort: number
  }
}

export type AgentType = "claude" | "codex" | "gemini"

export type CharacterSkin = "default" | "ponytail" | "plumber" | "glasses" | "mohawk"

export const CHARACTER_SKINS: CharacterSkin[] = ["default", "ponytail", "plumber", "glasses", "mohawk"]

export interface AgentVisual {
  type: AgentType
  workspace: ActiveWorkspace | null
}
