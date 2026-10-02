import { afterEach, expect, test, vi } from "vitest"
import { DagScheduler } from "../orchestrator/dag-scheduler"
import { fetchIssue, fetchIssuesByState } from "../tracker/linear-client"

afterEach(() => vi.unstubAllGlobals())

test("incoming Linear blocks relations become blockers even outside the active issue query", async () => {
  const node = {
    id: "task",
    identifier: "PROJ-2",
    title: "Implement",
    description: "",
    url: "https://linear.app/team/issue/PROJ-2",
    state: { id: "todo", name: "Todo", type: "unstarted" },
    team: { id: "team", key: "PROJ" },
    labels: { nodes: [] },
    relations: { nodes: [] },
    inverseRelations: {
      nodes: [
        {
          type: "blocks",
          issue: { id: "blocker", identifier: "PROJ-1", state: { id: "backlog", name: "Backlog", type: "backlog" } },
        },
      ],
    },
  }
  const queries: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const { query } = JSON.parse(String(init.body)) as { query: string }
      queries.push(query)
      const data = query.includes("GetIssuesByState") ? { team: { issues: { nodes: [node] } } } : { issue: node }
      return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
    }),
  )
  const issue = await fetchIssue("test-key", "task")
  expect(issue?.relations).toEqual([expect.objectContaining({ type: "blocked_by", relatedIssueId: "blocker" })])
  const issues = await fetchIssuesByState("test-key", "team", ["todo"])
  const dag = new DagScheduler("/tmp/unused-linear-dependency-test.json")
  dag.buildFromIssues(issues)
  expect(dag.getUnresolvedBlockers("task")).toEqual(["blocker"])
  expect(queries).toHaveLength(2)
  for (const query of queries) expect(query).toContain("inverseRelations")
})
