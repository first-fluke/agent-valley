import { afterEach, describe, expect, it, vi } from "vitest"
import type { WorkflowState } from "../setup/index"
import { buildGlobalYaml, buildProjectYaml, findWorkflowState, linearQuery, maskApiKey } from "../setup/index"

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
    const result = findWorkflowState(states, ["Cancelled", "Canceled"], "canceled")
    expect(result).toEqual({ id: "fff", name: "Canceled", type: "canceled" })
  })
})

// ── buildGlobalYaml ──────────────────────────────────────────────────────────

describe("buildGlobalYaml", () => {
  it("generates valid YAML with API key and agent type", () => {
    const content = buildGlobalYaml({ apiKey: "lin_api_test123", agentType: "claude", maxParallel: 3 })

    expect(content).toContain("api_key: lin_api_test123")
    expect(content).toContain("type: claude")
    expect(content).toContain("level: info")
    expect(content).toContain("port: 9741")
  })

  it("preserves different agent types", () => {
    expect(buildGlobalYaml({ apiKey: "key", agentType: "codex", maxParallel: 3 })).toContain("type: codex")
    expect(buildGlobalYaml({ apiKey: "key", agentType: "gemini", maxParallel: 3 })).toContain("type: gemini")
  })
})

// ── buildProjectYaml ─────────────────────────────────────────────────────────

describe("buildProjectYaml", () => {
  const config = {
    teamKey: "FIR",
    teamUuid: "uuid-team-123",
    webhookSecret: "lin_wh_secret456",
    todoStateId: "state-todo",
    inProgressStateId: "state-ip",
    doneStateId: "state-done",
    cancelledStateId: "state-cancel",
    workspaceRoot: "/home/user/workspaces",
  }

  it("generates valid YAML with all project fields", () => {
    const content = buildProjectYaml(config)

    expect(content).toContain("team_id: FIR")
    expect(content).toContain("team_uuid: uuid-team-123")
    expect(content).toContain("webhook_secret: lin_wh_secret456")
    expect(content).toContain("todo: state-todo")
    expect(content).toContain("in_progress: state-ip")
    expect(content).toContain("done: state-done")
    expect(content).toContain("cancelled: state-cancel")
    expect(content).toContain("root: /home/user/workspaces")
    expect(content).toContain("mode: merge")
  })

  it("includes default prompt template", () => {
    const content = buildProjectYaml(config)
    expect(content).toContain("{{issue.identifier}}")
    expect(content).toContain("{{issue.title}}")
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
