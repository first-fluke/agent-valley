/**
 * IssueTracker contract suite — reusable across fakes and real adapters.
 *
 * Usage:
 *   runIssueTrackerContract("fake", async () => ({
 *     tracker: new FakeIssueTracker(),
 *     seedIssue: async (issue) => { ... return issue.id },
 *   }))
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.6
 */

import { describe, expect, test } from "vitest"
import type { Issue } from "../../domain/models"
import type { IssueTracker } from "../../domain/ports/tracker"

export interface IssueTrackerContractHarness {
  tracker: IssueTracker
  seedIssue(issue: Issue): Promise<string>
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-c-1",
    identifier: "CON-1",
    title: "contract-seed",
    description: "",
    status: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-uuid", key: "CON" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

export function runIssueTrackerContract(label: string, makeHarness: () => Promise<IssueTrackerContractHarness>): void {
  describe(`IssueTracker contract — ${label}`, () => {
    test("fetchIssuesByState returns only issues with matching state ids", async () => {
      const { tracker, seedIssue } = await makeHarness()
      await seedIssue(
        makeIssue({ id: "a", identifier: "CON-A", status: { id: "state-todo", name: "Todo", type: "u" } }),
      )
      await seedIssue(
        makeIssue({ id: "b", identifier: "CON-B", status: { id: "state-ip", name: "In Progress", type: "s" } }),
      )
      await seedIssue(
        makeIssue({ id: "c", identifier: "CON-C", status: { id: "state-done", name: "Done", type: "c" } }),
      )

      const result = await tracker.fetchIssuesByState(["state-todo", "state-ip"])
      const ids = result.map((i) => i.id).sort()
      expect(ids).toEqual(["a", "b"])
    })

    test("updateIssueState is reflected on subsequent fetchIssuesByState", async () => {
      const { tracker, seedIssue } = await makeHarness()
      await seedIssue(
        makeIssue({ id: "x", identifier: "CON-X", status: { id: "state-todo", name: "Todo", type: "u" } }),
      )

      await tracker.updateIssueState("x", "state-ip")

      const stillTodo = await tracker.fetchIssuesByState(["state-todo"])
      expect(stillTodo.map((i) => i.id)).not.toContain("x")

      const nowInProgress = await tracker.fetchIssuesByState(["state-ip"])
      expect(nowInProgress.map((i) => i.id)).toContain("x")
    })

    test("addIssueComment is idempotent for the caller (same body twice does not throw)", async () => {
      const { tracker, seedIssue } = await makeHarness()
      const id = await seedIssue(makeIssue({ id: "y", identifier: "CON-Y" }))

      await expect(tracker.addIssueComment(id, "hello")).resolves.toBeUndefined()
      await expect(tracker.addIssueComment(id, "hello")).resolves.toBeUndefined()
    })

    test("addIssueLabel ignores duplicates — labels remain a set", async () => {
      const { tracker, seedIssue } = await makeHarness()
      const id = await seedIssue(makeIssue({ id: "z", identifier: "CON-Z", labels: ["existing"] }))

      await tracker.addIssueLabel(id, "alpha")
      await tracker.addIssueLabel(id, "alpha")
      await tracker.addIssueLabel(id, "beta")

      const labels = await tracker.fetchIssueLabels(id)
      expect([...labels].sort()).toEqual(["alpha", "beta", "existing"])
    })

    test("fetchIssueLabels on unknown issue returns empty array", async () => {
      const { tracker } = await makeHarness()
      const labels = await tracker.fetchIssueLabels("does-not-exist")
      expect(labels).toEqual([])
    })
  })
}
