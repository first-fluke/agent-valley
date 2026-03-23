import { afterEach, describe, expect, it, vi } from "vitest"
import type { EnvConfig, WorkflowState } from "../setup"
import { buildEnvContent, findWorkflowState, linearQuery, maskApiKey } from "../setup"

// ── findWorkflowState ────────────────────────────────────────────────────────

describe("findWorkflowState", () => {
  const states: WorkflowState[] = [
    { id: "aaa", name: "Backlog", type: "backlog" },
    { id: "bbb", name: "Todo", type: "unstarted" },
    { id: "ccc", name: "In Progress", type: "started" },
    { id: "ddd", name: "In Review", type: "started" },
    { id: "eee", name: "Done", type: "completed" },
    { id: "fff", name: "Canceled", type: "canceled" },
    { id: "ggg", name: "Duplicate", type: "canceled" },
  ]

  it("matches by exact name first", () => {
    const result = findWorkflowState(states, ["Todo"], "unstarted")
    expect(result).toEqual({ id: "bbb", name: "Todo", type: "unstarted" })
  })

  it("matches In Progress by name", () => {
    const result = findWorkflowState(states, ["In Progress"], "started")
    expect(result).toEqual({ id: "ccc", name: "In Progress", type: "started" })
  })

  it("matches Canceled with either spelling", () => {
    const result = findWorkflowState(states, ["Canceled", "Cancelled"], "canceled")
    expect(result).toEqual({ id: "fff", name: "Canceled", type: "canceled" })
  })

  it("falls back to type when name does not match", () => {
    const customStates: WorkflowState[] = [
      { id: "xxx", name: "Ready", type: "unstarted" },
      { id: "yyy", name: "Working", type: "started" },
    ]
    const result = findWorkflowState(customStates, ["Todo"], "unstarted")
    expect(result).toEqual({ id: "xxx", name: "Ready", type: "unstarted" })
  })

  it("returns first match when multiple states share a type", () => {
    // "In Progress" and "In Review" are both "started", but name match wins
    const result = findWorkflowState(states, ["In Review"], "started")
    expect(result).toEqual({ id: "ddd", name: "In Review", type: "started" })
  })

  it("returns undefined when no name or type matches", () => {
    const result = findWorkflowState(states, ["Nonexistent"], "nonexistent_type")
    expect(result).toBeUndefined()
  })

  it("handles empty states array", () => {
    const result = findWorkflowState([], ["Todo"], "unstarted")
    expect(result).toBeUndefined()
  })

  it("matches multiple name candidates", () => {
    // "Cancelled" (double l) doesn't exist but "Canceled" (single l) does
    const result = findWorkflowState(states, ["Cancelled", "Canceled"], "canceled")
    expect(result).toEqual({ id: "fff", name: "Canceled", type: "canceled" })
  })
})

// ── buildEnvContent ──────────────────────────────────────────────────────────

describe("buildEnvContent", () => {
  const config: EnvConfig = {
    apiKey: "lin_api_test123",
    teamKey: "FIR",
    teamUuid: "uuid-team-123",
    webhookSecret: "lin_wh_secret456",
    todoStateId: "state-todo",
    inProgressStateId: "state-ip",
    doneStateId: "state-done",
    cancelledStateId: "state-cancel",
    workspaceRoot: "/home/user/workspaces",
    agentType: "claude",
    maxParallel: 3,
  }

  it("generates valid .env content with all fields", () => {
    const content = buildEnvContent(config)

    expect(content).toContain("LINEAR_API_KEY=lin_api_test123")
    expect(content).toContain("LINEAR_TEAM_ID=FIR")
    expect(content).toContain("LINEAR_TEAM_UUID=uuid-team-123")
    expect(content).toContain("LINEAR_WEBHOOK_SECRET=lin_wh_secret456")
    expect(content).toContain("LINEAR_WORKFLOW_STATE_TODO=state-todo")
    expect(content).toContain("LINEAR_WORKFLOW_STATE_IN_PROGRESS=state-ip")
    expect(content).toContain("LINEAR_WORKFLOW_STATE_DONE=state-done")
    expect(content).toContain("LINEAR_WORKFLOW_STATE_CANCELLED=state-cancel")
    expect(content).toContain("WORKSPACE_ROOT=/home/user/workspaces")
    expect(content).toContain("AGENT_TYPE=claude")
    expect(content).toContain("MAX_PARALLEL=3")
    expect(content).toContain("SERVER_PORT=9741")
    expect(content).toContain("LOG_LEVEL=info")
    expect(content).toContain("LOG_FORMAT=json")
  })

  it("includes section comment headers", () => {
    const content = buildEnvContent(config)

    expect(content).toContain("# ── Linear Issue Tracker")
    expect(content).toContain("# ── Symphony Orchestrator")
    expect(content).toContain("# ── Agent Selection")
    expect(content).toContain("# ── Observability")
  })

  it("ends with newline", () => {
    const content = buildEnvContent(config)
    expect(content.endsWith("\n")).toBe(true)
  })

  it("preserves different agent types", () => {
    expect(buildEnvContent({ ...config, agentType: "codex" })).toContain("AGENT_TYPE=codex")
    expect(buildEnvContent({ ...config, agentType: "gemini" })).toContain("AGENT_TYPE=gemini")
  })

  it("handles special characters in values", () => {
    const content = buildEnvContent({ ...config, apiKey: "lin_api_a+b=c/d" })
    expect(content).toContain("LINEAR_API_KEY=lin_api_a+b=c/d")
  })
})

// ── maskApiKey ───────────────────────────────────────────────────────────────

describe("maskApiKey", () => {
  it("masks middle of long keys", () => {
    const masked = maskApiKey("lin_api_abcdef123456")
    expect(masked).toBe("lin_api_****3456")
  })

  it("returns **** for short keys", () => {
    expect(maskApiKey("short")).toBe("****")
    expect(maskApiKey("exactly12ch")).toBe("****")
  })

  it("handles 13-char key (boundary)", () => {
    const masked = maskApiKey("1234567890abc")
    expect(masked).toBe("12345678****0abc")
  })
})

// ── linearQuery ──────────────────────────────────────────────────────────────

describe("linearQuery", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("sends correct headers and body", async () => {
    let capturedInit: RequestInit | undefined

    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
    }) as unknown as typeof fetch

    await linearQuery("lin_api_key123", "{ teams { nodes { id } } }")

    expect(capturedInit?.method).toBe("POST")
    expect((capturedInit?.headers as Record<string, string>).Authorization).toBe("lin_api_key123")
    expect((capturedInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")

    const body = JSON.parse(capturedInit?.body as string)
    expect(body.query).toBe("{ teams { nodes { id } } }")
  })

  it("returns data on success", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: { teams: { nodes: [{ id: "1" }] } } }), { status: 200 }),
    ) as unknown as typeof fetch

    const result = await linearQuery("key", "{ teams { nodes { id } } }")
    expect((result as { teams: { nodes: { id: string }[] } }).teams.nodes[0]?.id).toBe("1")
  })

  it("throws on HTTP error", async () => {
    globalThis.fetch = vi.fn(async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch

    expect(linearQuery("bad_key", "{ viewer { id } }")).rejects.toThrow("Linear API HTTP 401")
  })

  it("throws on GraphQL error", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ errors: [{ message: "Invalid query" }] }), { status: 200 }),
    ) as unknown as typeof fetch

    expect(linearQuery("key", "{ bad }")).rejects.toThrow("Invalid query")
  })
})
