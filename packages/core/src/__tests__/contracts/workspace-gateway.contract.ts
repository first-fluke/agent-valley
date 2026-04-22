/**
 * WorkspaceGateway contract suite — reusable across fakes and real adapters.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.6
 */

import { describe, expect, test } from "vitest"
import type { Issue } from "../../domain/models"
import type { WorkspaceGateway } from "../../domain/ports/workspace"

export interface WorkspaceGatewayContractHarness {
  gateway: WorkspaceGateway
  /** Optional root override; when omitted, the gateway's default root is used. */
  root?: string
  /** Called by tests to flip the "hasChanges" state on the underlying backing store. */
  setChanges?(issueId: string, hasChanges: boolean): Promise<void>
}

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "ws-c-1",
    identifier: "WSP-1",
    title: "feat: contract issue",
    description: "",
    status: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-uuid", key: "WSP" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
    ...overrides,
  }
}

export function runWorkspaceGatewayContract(
  label: string,
  makeHarness: () => Promise<WorkspaceGatewayContractHarness>,
): void {
  describe(`WorkspaceGateway contract — ${label}`, () => {
    test("create returns a workspace whose branch carries a conventional prefix", async () => {
      const { gateway, root } = await makeHarness()
      const ws = await gateway.create(makeIssue({ title: "feat: one" }), root)
      expect(ws.issueId).toBe("ws-c-1")
      expect(ws.branch).toMatch(/^(feature|fix|refactor|hotfix|release)\//)
    })

    test("cleanup is idempotent — create → cleanup → create succeeds", async () => {
      const { gateway, root } = await makeHarness()
      const a = await gateway.create(makeIssue({ id: "recreate-1", identifier: "WSP-R1" }), root)
      await gateway.cleanup(a)
      const b = await gateway.create(makeIssue({ id: "recreate-1", identifier: "WSP-R1" }), root)
      expect(b.issueId).toBe("recreate-1")
    })

    test("detectUnfinishedWork reports the configured state", async () => {
      const harness = await makeHarness()
      const ws = await harness.gateway.create(makeIssue({ id: "du-1", identifier: "WSP-D1" }), harness.root)

      if (harness.setChanges) {
        await harness.setChanges("du-1", false)
        const clean = await harness.gateway.detectUnfinishedWork(ws)
        expect(clean.hasUncommittedChanges).toBe(false)

        await harness.setChanges("du-1", true)
        const dirty = await harness.gateway.detectUnfinishedWork(ws)
        expect(dirty.hasUncommittedChanges || dirty.hasCodeChanges).toBe(true)
      } else {
        const result = await harness.gateway.detectUnfinishedWork(ws)
        expect(result).toEqual(expect.objectContaining({ hasUncommittedChanges: expect.any(Boolean) }))
      }
    })
  })
}
