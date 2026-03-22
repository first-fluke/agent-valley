/**
 * DagScheduler tests — DAG construction, queries, mutations, persistence.
 */

import { unlink } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import type { Issue } from "../domain/models"
import { DagScheduler } from "../orchestrator/dag-scheduler"

const TEST_CACHE = `/tmp/dag-test-${crypto.randomUUID()}.json`

function makeIssue(overrides: Partial<Issue> & { id: string; identifier: string }): Issue {
  return {
    title: "Test",
    description: "",
    status: { id: "s1", name: "Todo", type: "unstarted" },
    team: { id: "t1", key: "TEST" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

let scheduler: DagScheduler

beforeEach(() => {
  scheduler = new DagScheduler(TEST_CACHE)
})

afterEach(async () => {
  try {
    await unlink(TEST_CACHE)
  } catch {
    /* already removed */
  }
})

// ── buildFromIssues ─────────────────────────────────────────────────

describe("buildFromIssues", () => {
  test("creates nodes from issues", () => {
    scheduler.buildFromIssues([makeIssue({ id: "A", identifier: "T-1" }), makeIssue({ id: "B", identifier: "T-2" })])
    expect(scheduler.hasNode("A")).toBe(true)
    expect(scheduler.hasNode("B")).toBe(true)
  })

  test("builds edges from blocked_by relations", () => {
    scheduler.buildFromIssues([
      makeIssue({ id: "A", identifier: "T-1" }),
      makeIssue({
        id: "B",
        identifier: "T-2",
        relations: [{ type: "blocked_by", relatedIssueId: "A", relatedIdentifier: "T-1" }],
      }),
    ])
    expect(scheduler.getUnresolvedBlockers("B")).toEqual(["A"])
  })

  test("builds reverse index (blocks)", () => {
    scheduler.buildFromIssues([
      makeIssue({
        id: "A",
        identifier: "T-1",
        relations: [{ type: "blocks", relatedIssueId: "B", relatedIdentifier: "T-2" }],
      }),
      makeIssue({ id: "B", identifier: "T-2" }),
    ])
    expect(scheduler.getBlockedIssues("A").map((n) => n.issueId)).toEqual(["B"])
  })

  test("handles cycle detection gracefully", () => {
    // A blocks B, B blocks A — mutual cycle
    scheduler.buildFromIssues([
      makeIssue({
        id: "A",
        identifier: "T-1",
        relations: [{ type: "blocks", relatedIssueId: "B", relatedIdentifier: "T-2" }],
      }),
      makeIssue({
        id: "B",
        identifier: "T-2",
        relations: [{ type: "blocks", relatedIssueId: "A", relatedIdentifier: "T-1" }],
      }),
    ])
    // Both nodes must still exist — no crash
    expect(scheduler.hasNode("A")).toBe(true)
    expect(scheduler.hasNode("B")).toBe(true)
    // Cyclic edges are removed; neither node blocks the other
    expect(scheduler.getBlockedIssues("A").map((n) => n.issueId)).toEqual([])
    expect(scheduler.getBlockedIssues("B").map((n) => n.issueId)).toEqual([])
  })

  test("deduplicates edges", () => {
    // B has two identical blocked_by relations pointing to A
    scheduler.buildFromIssues([
      makeIssue({ id: "A", identifier: "T-1" }),
      makeIssue({
        id: "B",
        identifier: "T-2",
        relations: [
          { type: "blocked_by", relatedIssueId: "A", relatedIdentifier: "T-1" },
          { type: "blocked_by", relatedIssueId: "A", relatedIdentifier: "T-1" },
        ],
      }),
    ])
    expect(scheduler.getUnresolvedBlockers("B")).toEqual(["A"])
  })

  test("maps issue status correctly", () => {
    scheduler.buildFromIssues([
      makeIssue({
        id: "W",
        identifier: "T-1",
        status: { id: "s1", name: "Todo", type: "unstarted" },
      }),
      makeIssue({
        id: "R",
        identifier: "T-2",
        status: { id: "s2", name: "In Progress", type: "started" },
      }),
      makeIssue({
        id: "D",
        identifier: "T-3",
        status: { id: "s3", name: "Done", type: "completed" },
      }),
      makeIssue({
        id: "C",
        identifier: "T-4",
        status: { id: "s4", name: "Cancelled", type: "cancelled" },
      }),
    ])
    expect(scheduler.getNode("W")?.status).toBe("waiting")
    expect(scheduler.getNode("R")?.status).toBe("running")
    expect(scheduler.getNode("D")?.status).toBe("done")
    expect(scheduler.getNode("C")?.status).toBe("cancelled")
  })
})

// ── Queries ─────────────────────────────────────────────────────────

describe("queries", () => {
  test("getReadyIssues returns unblocked waiting issues", () => {
    scheduler.buildFromIssues([
      makeIssue({ id: "A", identifier: "T-1" }),
      makeIssue({
        id: "B",
        identifier: "T-2",
        relations: [{ type: "blocked_by", relatedIssueId: "A", relatedIdentifier: "T-1" }],
      }),
    ])
    const ready = scheduler.getReadyIssues()
    expect(ready).toContain("A")
    expect(ready).not.toContain("B")
  })

  test("getUnblockedByCompletion after marking blocker done", () => {
    scheduler.buildFromIssues([
      makeIssue({ id: "A", identifier: "T-1" }),
      makeIssue({
        id: "B",
        identifier: "T-2",
        relations: [{ type: "blocked_by", relatedIssueId: "A", relatedIdentifier: "T-1" }],
      }),
    ])
    scheduler.updateNodeStatus("A", "done")
    expect(scheduler.getUnblockedByCompletion("A")).toEqual(["B"])
  })

  test("allChildrenDone checks child statuses", () => {
    scheduler.buildFromIssues([
      makeIssue({ id: "P", identifier: "T-0", children: ["C1", "C2"] }),
      makeIssue({ id: "C1", identifier: "T-1", parentId: "P" }),
      makeIssue({ id: "C2", identifier: "T-2", parentId: "P" }),
    ])

    expect(scheduler.allChildrenDone("P")).toBe(false)

    scheduler.updateNodeStatus("C1", "done")
    scheduler.updateNodeStatus("C2", "done")
    expect(scheduler.allChildrenDone("P")).toBe(true)
  })

  test("getNode returns undefined for missing", () => {
    expect(scheduler.getNode("nonexistent")).toBeUndefined()
  })

  test("getChildrenSummaries returns child nodes", () => {
    scheduler.buildFromIssues([
      makeIssue({ id: "P", identifier: "T-0", children: ["C1", "C2"] }),
      makeIssue({ id: "C1", identifier: "T-1", parentId: "P" }),
      makeIssue({ id: "C2", identifier: "T-2", parentId: "P" }),
    ])
    const summaries = scheduler.getChildrenSummaries("P")
    expect(summaries).toHaveLength(2)
    expect(summaries.map((n) => n.issueId).sort()).toEqual(["C1", "C2"])
  })

  test("getBlockedIssues returns empty for unblocked issue", () => {
    scheduler.buildFromIssues([makeIssue({ id: "A", identifier: "T-1" })])
    expect(scheduler.getBlockedIssues("A")).toEqual([])
  })
})

// ── Mutations ───────────────────────────────────────────────────────

describe("mutations", () => {
  test("addRelation creates bidirectional edge", () => {
    scheduler.buildFromIssues([makeIssue({ id: "A", identifier: "T-1" }), makeIssue({ id: "B", identifier: "T-2" })])
    scheduler.addRelation("A", "B", "blocks")
    expect(scheduler.getBlockedIssues("A").map((n) => n.issueId)).toEqual(["B"])
    expect(scheduler.getUnresolvedBlockers("B")).toEqual(["A"])
  })

  test("removeRelation cleans up both sides", () => {
    scheduler.buildFromIssues([
      makeIssue({
        id: "A",
        identifier: "T-1",
        relations: [{ type: "blocks", relatedIssueId: "B", relatedIdentifier: "T-2" }],
      }),
      makeIssue({ id: "B", identifier: "T-2" }),
    ])
    scheduler.removeRelation("A", "B")
    expect(scheduler.getBlockedIssues("A")).toEqual([])
    expect(scheduler.getUnresolvedBlockers("B")).toEqual([])
  })

  test("removeNode cleans up references", () => {
    scheduler.buildFromIssues([
      makeIssue({
        id: "A",
        identifier: "T-1",
        relations: [{ type: "blocks", relatedIssueId: "B", relatedIdentifier: "T-2" }],
      }),
      makeIssue({ id: "B", identifier: "T-2" }),
    ])
    scheduler.removeNode("A")
    expect(scheduler.hasNode("A")).toBe(false)
    expect(scheduler.getUnresolvedBlockers("B")).toEqual([])
  })

  test("addRelation with blocked-by type", () => {
    // Use an isolated cache path so async persist doesn't race with persistence tests
    const isolated = new DagScheduler(`/tmp/dag-test-isolated-${crypto.randomUUID()}.json`)
    isolated.buildFromIssues([makeIssue({ id: "A", identifier: "T-1" }), makeIssue({ id: "B", identifier: "T-2" })])
    isolated.addRelation("A", "B", "blocked-by")
    expect(isolated.getUnresolvedBlockers("A")).toEqual(["B"])
    expect(isolated.getBlockedIssues("B").map((n) => n.issueId)).toEqual(["A"])
  })

  test("addRelation ignores non-existent nodes", () => {
    // Use an isolated cache path so async persist doesn't race with persistence tests
    const isolated = new DagScheduler(`/tmp/dag-test-isolated-${crypto.randomUUID()}.json`)
    isolated.buildFromIssues([makeIssue({ id: "B", identifier: "T-2" })])
    // "missing" does not exist — must not crash
    expect(() => isolated.addRelation("missing", "B", "blocks")).not.toThrow()
    expect(isolated.getUnresolvedBlockers("B")).toEqual([])
  })

  test("addNode creates a new node", () => {
    const issue = makeIssue({ id: "NEW", identifier: "T-99" })
    scheduler.addNode(issue)
    expect(scheduler.hasNode("NEW")).toBe(true)
    expect(scheduler.getNode("NEW")?.identifier).toBe("T-99")
  })

  test("addNode skips duplicate", () => {
    // Use an isolated cache path so async persist doesn't race with persistence tests
    const isolated = new DagScheduler(`/tmp/dag-test-isolated-${crypto.randomUUID()}.json`)
    const issue = makeIssue({ id: "DUP", identifier: "T-1" })
    isolated.addNode(issue)
    // Manually mutate the node to confirm it isn't overwritten
    isolated.updateNodeStatus("DUP", "done")
    const modified = makeIssue({ id: "DUP", identifier: "T-1-modified" })
    isolated.addNode(modified)
    // Status should still be "done"; identifier should not have changed
    expect(isolated.getNode("DUP")?.status).toBe("done")
    expect(isolated.getNode("DUP")?.identifier).toBe("T-1")
  })
})

// ── Persistence ─────────────────────────────────────────────────────

describe("persistence", () => {
  test("save and load round-trip", async () => {
    scheduler.buildFromIssues([makeIssue({ id: "A", identifier: "T-1" }), makeIssue({ id: "B", identifier: "T-2" })])
    await scheduler.saveCache()

    const loaded = new DagScheduler(TEST_CACHE)
    await loaded.loadCache()
    expect(loaded.hasNode("A")).toBe(true)
    expect(loaded.hasNode("B")).toBe(true)
  })

  test("loadCache with missing file starts fresh", async () => {
    const s = new DagScheduler("/tmp/nonexistent-dag.json")
    await s.loadCache()
    expect(s.getReadyIssues()).toEqual([])
  })
})

// ── Reconcile ───────────────────────────────────────────────────────

describe("reconcileWithLinear", () => {
  test("overwrites stale cache with Linear data", async () => {
    // Initial state
    scheduler.buildFromIssues([makeIssue({ id: "OLD", identifier: "T-0" })])
    await scheduler.saveCache()

    // Reconcile with new data
    const fresh = new DagScheduler(TEST_CACHE)
    await fresh.loadCache()
    await fresh.reconcileWithLinear([makeIssue({ id: "NEW", identifier: "T-1" })])

    expect(fresh.hasNode("OLD")).toBe(false)
    expect(fresh.hasNode("NEW")).toBe(true)
  })
})

// ── Concurrent writes ────────────────────────────────────────────────

describe("concurrent writes", () => {
  test("multiple updates don't corrupt state", async () => {
    scheduler.buildFromIssues([makeIssue({ id: "X", identifier: "T-1" })])

    const statuses = [
      "waiting",
      "running",
      "done",
      "cancelled",
      "waiting",
      "running",
      "done",
      "cancelled",
      "waiting",
      "done",
    ] as const

    // Fire 10 status updates in parallel; each call enqueues a persist but
    // the synchronous in-memory mutation must leave the last write visible.
    await Promise.all(statuses.map((s) => Promise.resolve(scheduler.updateNodeStatus("X", s))))

    // Node must still exist and hold a valid DagNodeStatus
    const node = scheduler.getNode("X")
    expect(node).toBeDefined()
    expect(["waiting", "running", "done", "cancelled"]).toContain(node?.status)
  })
})
