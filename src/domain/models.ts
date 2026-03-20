/**
 * Domain Models — Pure types shared by all Symphony components.
 * No external dependencies. No business logic.
 */

export interface Issue {
  id: string
  identifier: string
  title: string
  description: string
  status: { id: string; name: string; type: string }
  team: { id: string; key: string }
  url: string
}

export type WorkspaceStatus = "idle" | "running" | "done" | "failed"

export interface Workspace {
  issueId: string
  path: string
  key: string
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

export interface OrchestratorRuntimeState {
  isRunning: boolean
  activeWorkspaces: Map<string, Workspace>
  lastEventAt: string | null
}
