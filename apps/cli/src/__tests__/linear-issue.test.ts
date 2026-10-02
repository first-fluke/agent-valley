import { resolveConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLinearIssue, findDraftState } from "../linear-issue"

const config = resolveConfig(null, {
  linear: {
    api_key: "test-key",
    team_id: "ACME",
    team_uuid: "team",
    webhook_secret: "secret",
    workflow_states: { todo: "todo", in_progress: "wip", done: "done", cancelled: "cancelled" },
  },
  workspace: { root: "/workspaces" },
  prompt: "Fix {{issue.title}}",
})
const created = { id: "new", identifier: "ACME-12", title: "Task", url: "https://linear.app/acme/issue/ACME-12" }
const input = { title: "Task", description: "Description" }
afterEach(() => vi.unstubAllGlobals())

function mockApi(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = []
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const { query, variables } = JSON.parse(init?.body as string)
      const operation = query.match(/(?:mutation|query)\s+(\w+)/)?.[1] as string
      calls.push({ operation, variables })
      const responses: Record<string, unknown> = {
        FindLabel: { issueLabels: { nodes: [] } },
        CreateLabel: { issueLabelCreate: { success: true, issueLabel: { id: `label:${variables.name}` } } },
        CreateIssue: { issueCreate: { success: true, issue: created } },
        GetIssueByIdentifier: { team: { issues: { nodes: [{ id: "blocker", identifier: "ACME-1" }] } } },
        DraftStates: { team: { states: { nodes: [{ id: "backlog", type: "backlog" }] } } },
        CreateIssueRelation: { issueRelationCreate: { issueRelation: { id: "relation" } } },
        UpdateIssueState: { issueUpdate: { success: true } },
        ...overrides,
      }
      return Response.json({ data: responses[operation] })
    }),
  )
  return calls
}

describe("Linear task publication", () => {
  it("attaches scope and score labels in the create mutation before Todo can dispatch", async () => {
    const calls = mockApi()
    expect(await createLinearIssue(config, { ...input, scope: "api", score: 4 })).toEqual(created)
    expect(calls.map((call) => call.operation)).toEqual([
      "FindLabel",
      "CreateLabel",
      "FindLabel",
      "CreateLabel",
      "CreateIssue",
    ])
    expect(calls.at(-1)?.variables).toMatchObject({ stateId: "todo", labelIds: ["label:scope:api", "label:score:4"] })
  })

  it("does not create an issue when a required routing label cannot be created", async () => {
    const calls = mockApi({ CreateLabel: { issueLabelCreate: { success: false } } })
    await expect(createLinearIssue(config, { ...input, scope: "api" })).rejects.toThrow("Failed to create label")
    expect(calls.some((call) => call.operation === "CreateIssue")).toBe(false)
  })

  it("creates blocked issues in Backlog and publishes only after the relation succeeds", async () => {
    const calls = mockApi()
    await createLinearIssue(config, { ...input, blockedBy: "ACME-1" })
    expect(calls.map((call) => call.operation)).toEqual([
      "GetIssueByIdentifier",
      "DraftStates",
      "CreateIssue",
      "CreateIssueRelation",
      "UpdateIssueState",
    ])
    expect(calls[2]?.variables.stateId).toBe("backlog")
    expect(calls[3]?.variables).toEqual({ issueId: "blocker", relatedIssueId: "new", type: "blocks" })
    expect(calls[4]?.variables).toEqual({ issueId: "new", stateId: "todo" })
  })

  it("leaves an actionable draft when relation creation fails", async () => {
    const calls = mockApi({ CreateIssueRelation: {} })
    await expect(createLinearIssue(config, { ...input, blockedBy: "ACME-1" })).rejects.toThrow("created in Backlog")
    expect(calls.some((call) => call.operation === "UpdateIssueState")).toBe(false)
  })

  it("does not silently select a same-number blocker from another team", async () => {
    const calls = mockApi()
    await expect(createLinearIssue(config, { ...input, blockedBy: "OTHER-1" })).rejects.toThrow("No issue was created")
    expect(calls).toHaveLength(1)
  })

  it("refuses to use the configured Todo state as a draft", async () => {
    mockApi({ DraftStates: { team: { states: { nodes: [{ id: "todo", type: "backlog" }] } } } })
    await expect(findDraftState(config)).rejects.toThrow("Backlog state is required")
  })
})
