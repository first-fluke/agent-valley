/**
 * Linear client types tests — Zod schema parsing for DAG-related fields.
 *
 * nodeToIssue() is a private (non-exported) function. We exercise it indirectly
 * by testing the Zod schemas it relies on for runtime validation:
 *   - linearIssueNodeSchema  — per-node parsing, including DAG fields
 *   - linearTeamIssuesDataSchema — full team issues response parsing
 */

import { describe, expect, test, vi } from "vitest"
import { linearIssueNodeSchema, linearTeamIssuesDataSchema } from "../tracker/types"

// ── Shared fixtures ──────────────────────────────────────────────────

const baseState = { id: "s1", name: "Todo", type: "unstarted" }
const baseTeam = { id: "t1", key: "ACR" }

function makeBaseNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "issue-1",
    identifier: "ACR-1",
    title: "Test issue",
    description: "A test description",
    url: "https://linear.app/acr/issue/ACR-1",
    state: baseState,
    team: baseTeam,
    ...overrides,
  }
}

// ── linearIssueNodeSchema — DAG fields ───────────────────────────────

describe("linearIssueNodeSchema — DAG fields", () => {
  test("parses node with parent, children, and relations", () => {
    const raw = makeBaseNode({
      labels: { nodes: [{ name: "backend" }] },
      parent: { id: "parent-1", identifier: "ACR-0" },
      children: {
        nodes: [{ id: "child-1", identifier: "ACR-2", state: baseState }],
      },
      relations: {
        nodes: [
          {
            type: "blocks",
            relatedIssue: { id: "rel-1", identifier: "ACR-3", state: baseState },
          },
        ],
      },
    })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    const data = result.data
    expect(data.id).toBe("issue-1")
    expect(data.identifier).toBe("ACR-1")
    expect(data.labels.nodes).toEqual([{ name: "backend" }])

    // parent
    expect(data.parent).toEqual({ id: "parent-1", identifier: "ACR-0" })

    // children
    expect(data.children.nodes).toHaveLength(1)
    expect(data.children.nodes[0]!.id).toBe("child-1")
    expect(data.children.nodes[0]!.identifier).toBe("ACR-2")
    expect(data.children.nodes[0]!.state).toEqual(baseState)

    // relations
    expect(data.relations.nodes).toHaveLength(1)
    expect(data.relations.nodes[0]!.type).toBe("blocks")
    expect(data.relations.nodes[0]!.relatedIssue.id).toBe("rel-1")
    expect(data.relations.nodes[0]!.relatedIssue.identifier).toBe("ACR-3")
  })

  test("defaults missing parent, children, and relations to safe empty values", () => {
    const raw = makeBaseNode()
    // no labels, no parent, no children, no relations

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    const data = result.data
    expect(data.parent).toBeNull()
    expect(data.children).toEqual({ nodes: [] })
    expect(data.relations).toEqual({ nodes: [] })
    expect(data.labels).toEqual({ nodes: [] })
  })

  test("handles explicit null parent gracefully", () => {
    const raw = makeBaseNode({ parent: null })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.parent).toBeNull()
  })

  test("handles null description by coercing to empty string", () => {
    const raw = makeBaseNode({ description: null })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.description).toBe("")
  })

  test("preserves non-null description as-is", () => {
    const raw = makeBaseNode({ description: "My description" })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.description).toBe("My description")
  })

  test("rejects node missing required id", () => {
    const raw = makeBaseNode()
    const invalid = { ...raw }
    delete (invalid as Record<string, unknown>).id

    const result = linearIssueNodeSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  test("rejects node missing required title", () => {
    const raw = makeBaseNode()
    const invalid = { ...raw }
    delete (invalid as Record<string, unknown>).title

    const result = linearIssueNodeSchema.safeParse(invalid)
    expect(result.success).toBe(false)
  })

  test("parses node with multiple children and multiple relations", () => {
    const raw = makeBaseNode({
      children: {
        nodes: [
          { id: "child-1", identifier: "ACR-2", state: baseState },
          { id: "child-2", identifier: "ACR-3", state: { id: "s2", name: "In Progress", type: "started" } },
        ],
      },
      relations: {
        nodes: [
          { type: "blocks", relatedIssue: { id: "rel-1", identifier: "ACR-10", state: baseState } },
          { type: "blocked-by", relatedIssue: { id: "rel-2", identifier: "ACR-11", state: baseState } },
          { type: "duplicate", relatedIssue: { id: "rel-3", identifier: "ACR-12", state: baseState } },
        ],
      },
    })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.children.nodes).toHaveLength(2)
    expect(result.data.relations.nodes).toHaveLength(3)
    expect(result.data.relations.nodes[1]!.type).toBe("blocked-by")
    expect(result.data.relations.nodes[2]!.type).toBe("duplicate")
  })

  test("parses node with empty children and relations nodes arrays", () => {
    const raw = makeBaseNode({
      children: { nodes: [] },
      relations: { nodes: [] },
    })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.children.nodes).toEqual([])
    expect(result.data.relations.nodes).toEqual([])
  })

  test("parses node with score label", () => {
    const raw = makeBaseNode({
      labels: { nodes: [{ name: "score:7" }, { name: "backend" }] },
    })

    const result = linearIssueNodeSchema.safeParse(raw)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.labels.nodes).toHaveLength(2)
    expect(result.data.labels.nodes[0]!.name).toBe("score:7")
  })
})

// ── linearTeamIssuesDataSchema — with DAG data ───────────────────────

describe("linearTeamIssuesDataSchema — with DAG data", () => {
  test("parses team issues response with DAG relationships", () => {
    const data = {
      team: {
        issues: {
          nodes: [
            makeBaseNode({
              labels: { nodes: [{ name: "backend" }] },
              parent: { id: "parent-1", identifier: "ACR-0" },
              children: {
                nodes: [{ id: "child-1", identifier: "ACR-2", state: baseState }],
              },
              relations: {
                nodes: [
                  {
                    type: "blocks",
                    relatedIssue: { id: "rel-1", identifier: "ACR-3", state: baseState },
                  },
                ],
              },
            }),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    const nodes = result.data.team?.issues.nodes ?? []
    expect(nodes).toHaveLength(1)

    const node = nodes[0]!
    expect(node.parent).toEqual({ id: "parent-1", identifier: "ACR-0" })
    expect(node.children.nodes[0]!.id).toBe("child-1")
    expect(node.relations.nodes[0]!.type).toBe("blocks")
    expect(node.relations.nodes[0]!.relatedIssue.identifier).toBe("ACR-3")
  })

  test("parses team issues response without relationships", () => {
    const data = {
      team: {
        issues: {
          nodes: [makeBaseNode()],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    const node = result.data.team?.issues.nodes[0]
    expect(node?.parent).toBeNull()
    expect(node?.children).toEqual({ nodes: [] })
    expect(node?.relations).toEqual({ nodes: [] })
  })

  test("parses paginated response with hasNextPage true and endCursor", () => {
    const data = {
      team: {
        issues: {
          nodes: [makeBaseNode()],
          pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
        },
      },
    }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    const pageInfo = result.data.team?.issues.pageInfo
    expect(pageInfo?.hasNextPage).toBe(true)
    expect(pageInfo?.endCursor).toBe("cursor-abc")
  })

  test("parses response without pageInfo (optional field)", () => {
    const data = {
      team: {
        issues: {
          nodes: [makeBaseNode()],
        },
      },
    }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.team?.issues.pageInfo).toBeUndefined()
  })

  test("parses response with multiple issues including mixed DAG relationships", () => {
    const data = {
      team: {
        issues: {
          nodes: [
            makeBaseNode({
              id: "issue-1",
              identifier: "ACR-1",
              parent: { id: "parent-0", identifier: "ACR-0" },
              children: { nodes: [] },
              relations: {
                nodes: [{ type: "blocks", relatedIssue: { id: "issue-2", identifier: "ACR-2", state: baseState } }],
              },
            }),
            makeBaseNode({
              id: "issue-2",
              identifier: "ACR-2",
              parent: null,
              children: {
                nodes: [{ id: "issue-3", identifier: "ACR-3", state: baseState }],
              },
              relations: {
                nodes: [{ type: "blocked-by", relatedIssue: { id: "issue-1", identifier: "ACR-1", state: baseState } }],
              },
            }),
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    const nodes = result.data.team?.issues.nodes ?? []
    expect(nodes).toHaveLength(2)

    const first = nodes[0]!
    expect(first.parent?.id).toBe("parent-0")
    expect(first.relations.nodes[0]!.type).toBe("blocks")

    const second = nodes[1]!
    expect(second.parent).toBeNull()
    expect(second.children.nodes[0]!.id).toBe("issue-3")
    expect(second.relations.nodes[0]!.type).toBe("blocked-by")
  })

  test("parses response with null team", () => {
    const data = { team: null }

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.team).toBeNull()
  })

  test("rejects response with missing team field", () => {
    const data = {}

    const result = linearTeamIssuesDataSchema.safeParse(data)
    expect(result.success).toBe(false)
  })
})

// ── fetchIssueByIdentifier — identifier parsing ───────────────────

describe("fetchIssueByIdentifier — identifier→number parsing", () => {
  /**
   * Regression: fetchIssueByIdentifier used `filter: { identifier: { eq: $identifier } }`
   * which does not exist in Linear's IssueFilter. The fix extracts the numeric part
   * and uses `filter: { number: { eq: $number } }`.
   */

  test("extracts number from standard identifier format", async () => {
    // We test the parsing logic by importing and calling the function with a mock
    const { fetchIssueByIdentifier } = await import("../tracker/linear-client")

    // Mock fetch to capture the variables sent to Linear API
    let capturedVariables: Record<string, unknown> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      capturedVariables = body.variables
      return new Response(
        JSON.stringify({ data: { team: { issues: { nodes: [{ id: "uuid-1", identifier: "FIR-57" }] } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    try {
      const result = await fetchIssueByIdentifier("fake-key", "team-uuid", "FIR-57")
      expect(capturedVariables.number).toBe(57)
      expect(capturedVariables.teamId).toBe("team-uuid")
      expect(result?.identifier).toBe("FIR-57")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("extracts number from multi-digit identifier", async () => {
    const { fetchIssueByIdentifier } = await import("../tracker/linear-client")

    let capturedVariables: Record<string, unknown> = {}
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      capturedVariables = body.variables
      return new Response(JSON.stringify({ data: { team: { issues: { nodes: [] } } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as unknown as typeof fetch

    try {
      const result = await fetchIssueByIdentifier("fake-key", "team-uuid", "ACR-123")
      expect(capturedVariables.number).toBe(123)
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("returns null for invalid identifier without number", async () => {
    const { fetchIssueByIdentifier } = await import("../tracker/linear-client")

    const result = await fetchIssueByIdentifier("fake-key", "team-uuid", "NO-NUMBER-HERE")
    expect(result).toBeNull()
  })
})

// ── createIssueRelation — only accepts valid Linear API types ─────

describe("createIssueRelation — Linear API type contract", () => {
  /**
   * Regression: Linear API enum IssueRelationType only has "blocks", "related", "duplicate".
   * There is no "blocked-by". Callers must swap direction before calling.
   *
   * Design: createIssueRelation is a thin infra wrapper — no business logic.
   * Direction swap happens in the presentation layer (CLI).
   */

  function mockLinearFetch(): { getCaptured: () => Record<string, unknown>; restore: () => void } {
    let captured: Record<string, unknown> = {}
    const original = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string)
      captured = body.variables
      return new Response(
        JSON.stringify({ data: { issueRelationCreate: { issueRelation: { id: "r1", type: "blocks" } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch
    return {
      getCaptured: () => captured,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  test("blocks sends issueId and relatedIssueId as-is", async () => {
    const { createIssueRelation } = await import("../tracker/linear-client")
    const { getCaptured, restore } = mockLinearFetch()

    try {
      await createIssueRelation("fake-key", "parent-id", "child-id", "blocks")
      expect(getCaptured().issueId).toBe("parent-id")
      expect(getCaptured().relatedIssueId).toBe("child-id")
      expect(getCaptured().type).toBe("blocks")
    } finally {
      restore()
    }
  })

  test("CLI --blocked-by pattern: caller swaps direction and uses blocks", async () => {
    /**
     * This test documents the correct calling pattern from CLI:
     * "FIR-58 blocked-by FIR-57" → createIssueRelation(key, FIR-57.id, FIR-58.id, "blocks")
     */
    const { createIssueRelation } = await import("../tracker/linear-client")
    const { getCaptured, restore } = mockLinearFetch()

    try {
      const blockerId = "fir-57-uuid"
      const blockedId = "fir-58-uuid"
      // Caller swaps: blocker.id first, blocked.id second, type "blocks"
      await createIssueRelation("fake-key", blockerId, blockedId, "blocks")
      expect(getCaptured().issueId).toBe(blockerId)
      expect(getCaptured().relatedIssueId).toBe(blockedId)
      expect(getCaptured().type).toBe("blocks")
    } finally {
      restore()
    }
  })
})
