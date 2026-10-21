/**
 * Dashboard-side TeamState types.
 * Reuses AgentType and ActiveIssue from domain. Adds serializable TeamNode (array-based).
 */

export type { ActiveIssue, AgentType } from "@agent-valley/core/domain/ledger"

import type { ActiveIssue, AgentType } from "@agent-valley/core/domain/ledger"

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
