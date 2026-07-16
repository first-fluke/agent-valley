/**
 * Ledger Domain Types — Event sourcing types for team dashboard broadcasting.
 * No external dependencies. No business logic.
 *
 * Design doc: docs/plans/team-dashboard-design.md
 */

// ── Agent Types ──────────────────────────────────────────────────────────────

export type AgentType = "claude" | "codex" | "antigravity" | "cursor" | "grok"

// ── Ledger Event (Discriminated Union) ───────────────────────────────────────

interface LedgerEventBase {
  v: 1
  seq: number
  relayTimestamp: string
  clientTimestamp: string
  nodeId: string // "{username}:{machineId}"
}

export interface NodeJoinEvent extends LedgerEventBase {
  type: "node.join"
  payload: { defaultAgentType: AgentType; maxParallel: number; displayName: string }
}

export interface NodeReconnectEvent extends LedgerEventBase {
  type: "node.reconnect"
  payload: { lastSeq: number }
}

export interface NodeLeaveEvent extends LedgerEventBase {
  type: "node.leave"
  payload: { reason: "graceful" | "crash" | "timeout" }
}

export interface AgentStartEvent extends LedgerEventBase {
  type: "agent.start"
  payload: { agentType: AgentType; issueKey: string; issueId: string }
}

export interface AgentDoneEvent extends LedgerEventBase {
  type: "agent.done"
  payload: { issueKey: string; issueId: string; durationMs: number }
}

export interface AgentFailedEvent extends LedgerEventBase {
  type: "agent.failed"
  payload: {
    issueKey: string
    issueId: string
    error: { code: string; message: string; retryable: boolean }
  }
}

export interface AgentCancelledEvent extends LedgerEventBase {
  type: "agent.cancelled"
  payload: { issueKey: string; issueId: string; reason: string }
}

export type LedgerEvent =
  | NodeJoinEvent
  | NodeReconnectEvent
  | NodeLeaveEvent
  | AgentStartEvent
  | AgentDoneEvent
  | AgentFailedEvent
  | AgentCancelledEvent

export type LedgerEventType = LedgerEvent["type"]

// ── Team State (derived from ledger replay) ──────────────────────────────────

export interface ActiveIssue {
  issueKey: string
  issueId: string
  agentType: AgentType
  startedAt: string
}

export interface NodePresence {
  nodeId: string
  displayName: string
  defaultAgentType: AgentType
  maxParallel: number
  online: boolean
  joinedAt: string
  activeIssues: ActiveIssue[]
}

export interface TeamState {
  nodes: Map<string, NodePresence>
  lastSeq: number
}

// ── Publisher Interface (Application boundary) ───────────────────────────────

export interface LedgerEventPublisher {
  publish(event: Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">): Promise<void>
  dispose(): Promise<void>
}
