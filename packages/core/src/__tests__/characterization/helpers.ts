/**
 * Characterization test helpers — shared fakes and fixtures.
 * Used to isolate Orchestrator behavior from real external I/O.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 2 (M0)
 */

import type { Config } from "../../config/yaml-loader"
import type { Issue, Workspace } from "../../domain/models"
import type { AgentConfig, AgentEvent, AgentEventType, AgentSession } from "../../sessions/agent-session"

// ── Fixtures ────────────────────────────────────────────────────────

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PROJ-1",
    title: "feat: test issue",
    description: "A characterization test issue",
    status: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-uuid", key: "PROJ" },
    labels: [],
    url: "https://linear.app/proj/issue/PROJ-1",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    trackerKind: "linear",
    linearApiKey: "lin_api_test",
    linearTeamId: "PROJ",
    linearTeamUuid: "team-uuid",
    linearWebhookSecret: "whsec_test",
    workflowStates: {
      todo: "state-todo",
      inProgress: "state-ip",
      done: "state-done",
      cancelled: "state-cancelled",
    },
    workspaceRoot: "/tmp/characterization-workspace",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 2,
    serverPort: 9741,
    logLevel: "error",
    logFormat: "json",
    deliveryMode: "merge",
    routingRules: [],
    promptTemplate: "Prompt for {{issue.identifier}}: {{issue.title}}",
    ...overrides,
  } as Config
}

// ── Fake AgentSession — never spawns real processes ────────────────

/**
 * FakeAgentSession captures start/execute/cancel/kill/dispose calls
 * and lets tests drive `complete` / `error` events synchronously.
 */
export class FakeAgentSession implements AgentSession {
  startCalls: AgentConfig[] = []
  executeCalls: string[] = []
  cancelCalls = 0
  killCalls = 0
  disposeCalls = 0

  private handlers = new Map<AgentEventType, Array<(e: AgentEvent) => void>>()
  private alive = false

  static instances: FakeAgentSession[] = []
  static resetRegistry(): void {
    FakeAgentSession.instances = []
  }

  constructor() {
    FakeAgentSession.instances.push(this)
  }

  async start(config: AgentConfig): Promise<void> {
    this.startCalls.push(config)
    this.alive = true
  }

  async execute(prompt: string): Promise<void> {
    this.executeCalls.push(prompt)
  }

  async cancel(): Promise<void> {
    this.cancelCalls++
    this.alive = false
  }

  async kill(): Promise<void> {
    this.killCalls++
    this.alive = false
  }

  isAlive(): boolean {
    return this.alive
  }

  on<T extends AgentEventType>(event: T, handler: (e: Extract<AgentEvent, { type: T }>) => void): void {
    const arr = this.handlers.get(event) ?? []
    arr.push(handler as (e: AgentEvent) => void)
    this.handlers.set(event, arr)
  }

  off<T extends AgentEventType>(event: T, handler: (e: Extract<AgentEvent, { type: T }>) => void): void {
    const arr = this.handlers.get(event) ?? []
    this.handlers.set(
      event,
      arr.filter((h) => h !== (handler as (e: AgentEvent) => void)),
    )
  }

  async dispose(): Promise<void> {
    this.disposeCalls++
  }

  /** Test-driver API — trigger events from outside. */
  emit<T extends AgentEventType>(event: T, payload: Extract<AgentEvent, { type: T }>): void {
    const arr = this.handlers.get(event) ?? []
    for (const h of arr) h(payload)
  }
}

// ── Linear client mock setup ───────────────────────────────────────

export interface LinearClientMockState {
  fetchIssuesByState: ReturnType<typeof import("vitest").vi.fn>
  fetchIssueLabels: ReturnType<typeof import("vitest").vi.fn>
  updateIssueState: ReturnType<typeof import("vitest").vi.fn>
  addIssueComment: ReturnType<typeof import("vitest").vi.fn>
  addIssueLabel: ReturnType<typeof import("vitest").vi.fn>
}

// ── Workspace fixture ───────────────────────────────────────────────

export function makeWorkspace(issue: Issue, overrides: Partial<Workspace> = {}): Workspace {
  return {
    issueId: issue.id,
    path: `/tmp/fake/${issue.identifier}`,
    key: issue.identifier,
    branch: `feature/${issue.identifier}`,
    status: "idle",
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * Flush microtasks. Orchestrator performs many `catch()` chains on
 * fire-and-forget comment posts; awaiting `setTimeout(0)` lets them settle.
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
