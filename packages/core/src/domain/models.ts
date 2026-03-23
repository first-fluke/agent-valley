/**
 * Domain Models — Pure types shared by all Symphony components.
 * No external dependencies. No business logic.
 */

export interface IssueRelation {
  type: "blocks" | "blocked_by" | "related" | "duplicate"
  relatedIssueId: string
  relatedIdentifier: string
}

export interface Issue {
  id: string
  identifier: string
  title: string
  description: string
  status: { id: string; name: string; type: string }
  team: { id: string; key: string }
  labels: string[]
  url: string
  /** ISO/IEC 14143 function point score (1–10), null = not yet analyzed */
  score: number | null
  parentId: string | null
  children: string[]
  relations: IssueRelation[]
}

/**
 * ISO/IEC 14143 function point analysis result.
 * Produced by LLM analyzing issue title + description.
 */
export interface ScoreAnalysis {
  /** Final score (1–10) */
  score: number
  /** Analysis depth: "quick" (simplified) or "detailed" (IFPUG re-weighted) */
  phase: "quick" | "detailed"
  /** ISO/IEC 14143 five function type counts */
  functionTypes: {
    /** External Input — data entering the system from outside */
    ei: number
    /** External Output — data leaving the system to outside */
    eo: number
    /** External Inquiry — input + output combination for queries */
    eq: number
    /** Internal Logical File — internally maintained data group */
    ilf: number
    /** External Interface File — externally referenced data */
    eif: number
  }
  /** LLM reasoning for the score (for logging/debugging) */
  reasoning: string
}

/** Parse a score:N label from a list of label names. Returns null if none found or invalid. */
export function parseScoreFromLabels(labels: string[]): number | null {
  for (const label of labels) {
    const match = label.match(/^score:(\d+)$/)
    if (match) {
      const value = Number(match[1])
      if (value >= 1 && value <= 10) return value
    }
  }
  return null
}

export type WorkspaceStatus = "idle" | "running" | "done" | "failed"

export interface Workspace {
  issueId: string
  path: string
  key: string
  branch: string
  status: WorkspaceStatus
  createdAt: string
}

export interface RunAttempt {
  id: string
  issueId: string
  workspacePath: string
  startedAt: string
  finishedAt: string | null
  exitCode: number | null
  agentOutput: string | null
}

export interface RetryEntry {
  issueId: string
  attemptCount: number
  nextRetryAt: string
  lastError: string
}

export interface WaitingEntry {
  issueId: string
  identifier: string
  blockedBy: string[]
  enqueuedAt: string
}

export interface OrchestratorRuntimeState {
  isRunning: boolean
  activeWorkspaces: Map<string, Workspace>
  waitingIssues: Map<string, WaitingEntry>
  lastEventAt: string | null
}

// ── DAG Types ─────────────────────────────────────────────────────────

export type DagNodeStatus = "waiting" | "ready" | "running" | "done" | "cancelled"

export interface DagNode {
  issueId: string
  identifier: string
  status: DagNodeStatus
  parentId: string | null
  children: string[]
  blockedBy: string[]
  blocks: string[]
}

export interface DagCache {
  version: number
  updatedAt: string
  nodes: Record<string, DagNode>
}
