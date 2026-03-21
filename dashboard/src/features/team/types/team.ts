/**
 * Dashboard-side TeamState types.
 * Mirrors domain types but uses serializable structures (arrays instead of Maps/Sets).
 */

export type AgentType = "claude" | "codex" | "gemini"

export interface ActiveIssue {
  issueKey: string
  issueId: string
  agentType: AgentType
  startedAt: string
}

export interface TeamNode {
  nodeId: string
  displayName: string
  defaultAgentType: AgentType
  maxParallel: number
  online: boolean
  joinedAt: string
  activeIssues: ActiveIssue[]
}

export interface TeamState {
  nodes: TeamNode[]
  lastSeq: number
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error"
