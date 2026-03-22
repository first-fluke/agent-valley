/**
 * DAG pure function tests — cycle detection, blocker resolution, ready issues, parent completion.
 */

import { describe, expect, test } from "vitest"
import {
  allChildrenDone,
  detectCycles,
  getReadyIssues,
  getUnblockedByCompletion,
  getUnresolvedBlockers,
} from "../domain/dag"
import type { DagNode } from "../domain/models"

function makeNode(overrides: Partial<DagNode> & { issueId: string }): DagNode {
  return {
    identifier: overrides.issueId,
    status: "waiting",
    parentId: null,
    children: [],
    blockedBy: [],
    blocks: [],
    ...overrides,
  }
}

// ── detectCycles ────────────────────────────────────────────────────

describe("detectCycles", () => {
  test("no cycles in linear chain", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", blocks: ["B"] }),
      B: makeNode({ issueId: "B", blockedBy: ["A"], blocks: ["C"] }),
      C: makeNode({ issueId: "C", blockedBy: ["B"] }),
    }
    expect(detectCycles(nodes)).toEqual([])
  })

  test("detects A <-> B cycle", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", blockedBy: ["B"], blocks: ["B"] }),
      B: makeNode({ issueId: "B", blockedBy: ["A"], blocks: ["A"] }),
    }
    const cycles = detectCycles(nodes)
    expect(cycles.length).toBe(1)
    expect(cycles[0]).toContain("A")
    expect(cycles[0]).toContain("B")
  })

  test("independent nodes have no cycles", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A" }),
      B: makeNode({ issueId: "B" }),
    }
    expect(detectCycles(nodes)).toEqual([])
  })

  test("empty graph has no cycles", () => {
    expect(detectCycles({})).toEqual([])
  })
})

// ── getUnresolvedBlockers ───────────────────────────────────────────

describe("getUnresolvedBlockers", () => {
  test("returns blockers present in DAG", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "running" }),
      B: makeNode({ issueId: "B", blockedBy: ["A"] }),
    }
    expect(getUnresolvedBlockers(nodes, "B")).toEqual(["A"])
  })

  test("blocker not in DAG is treated as resolved", () => {
    const nodes: Record<string, DagNode> = {
      B: makeNode({ issueId: "B", blockedBy: ["missing-issue"] }),
    }
    expect(getUnresolvedBlockers(nodes, "B")).toEqual([])
  })

  test("done blocker is treated as resolved", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "done" }),
      B: makeNode({ issueId: "B", blockedBy: ["A"] }),
    }
    expect(getUnresolvedBlockers(nodes, "B")).toEqual([])
  })

  test("cancelled blocker is treated as resolved", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "cancelled" }),
      B: makeNode({ issueId: "B", blockedBy: ["A"] }),
    }
    expect(getUnresolvedBlockers(nodes, "B")).toEqual([])
  })

  test("non-existent issue returns empty", () => {
    expect(getUnresolvedBlockers({}, "nope")).toEqual([])
  })
})

// ── getReadyIssues ──────────────────────────────────────────────────

describe("getReadyIssues", () => {
  test("issues with no blockers are ready", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "waiting" }),
      B: makeNode({ issueId: "B", status: "waiting" }),
    }
    expect(getReadyIssues(nodes).sort()).toEqual(["A", "B"])
  })

  test("blocked issues are not ready", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "running" }),
      B: makeNode({ issueId: "B", status: "waiting", blockedBy: ["A"] }),
    }
    expect(getReadyIssues(nodes)).toEqual([])
  })

  test("running/done issues are not included", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "running" }),
      B: makeNode({ issueId: "B", status: "done" }),
    }
    expect(getReadyIssues(nodes)).toEqual([])
  })
})

// ── getUnblockedByCompletion ────────────────────────────────────────

describe("getUnblockedByCompletion", () => {
  test("completing blocker unblocks dependent", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "done", blocks: ["B"] }),
      B: makeNode({ issueId: "B", status: "waiting", blockedBy: ["A"] }),
    }
    expect(getUnblockedByCompletion(nodes, "A")).toEqual(["B"])
  })

  test("does not unblock if other blockers remain", () => {
    const nodes: Record<string, DagNode> = {
      A: makeNode({ issueId: "A", status: "done", blocks: ["C"] }),
      B: makeNode({ issueId: "B", status: "running", blocks: ["C"] }),
      C: makeNode({ issueId: "C", status: "waiting", blockedBy: ["A", "B"] }),
    }
    expect(getUnblockedByCompletion(nodes, "A")).toEqual([])
  })

  test("non-existent completed issue returns empty", () => {
    expect(getUnblockedByCompletion({}, "nope")).toEqual([])
  })
})

// ── allChildrenDone ─────────────────────────────────────────────────

describe("allChildrenDone", () => {
  test("all children done returns true", () => {
    const nodes: Record<string, DagNode> = {
      P: makeNode({ issueId: "P", children: ["C1", "C2"] }),
      C1: makeNode({ issueId: "C1", status: "done", parentId: "P" }),
      C2: makeNode({ issueId: "C2", status: "done", parentId: "P" }),
    }
    expect(allChildrenDone(nodes, "P")).toBe(true)
  })

  test("one child not done returns false", () => {
    const nodes: Record<string, DagNode> = {
      P: makeNode({ issueId: "P", children: ["C1", "C2"] }),
      C1: makeNode({ issueId: "C1", status: "done", parentId: "P" }),
      C2: makeNode({ issueId: "C2", status: "running", parentId: "P" }),
    }
    expect(allChildrenDone(nodes, "P")).toBe(false)
  })

  test("no children returns true (vacuous)", () => {
    const nodes: Record<string, DagNode> = {
      P: makeNode({ issueId: "P", children: [] }),
    }
    expect(allChildrenDone(nodes, "P")).toBe(true)
  })

  test("child not in DAG treated as done", () => {
    const nodes: Record<string, DagNode> = {
      P: makeNode({ issueId: "P", children: ["missing"] }),
    }
    expect(allChildrenDone(nodes, "P")).toBe(true)
  })
})
