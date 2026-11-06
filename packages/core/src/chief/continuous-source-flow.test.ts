import { describe, expect, it, vi } from "vitest"
import { codeDeliverySchema } from "./code-delivery-contract"
import type { ContinuousBaseline, Operation } from "./continuous-contract"
import { runContinuousOperation } from "./continuous-operation"
import { baseline, fixture, operation, timestamp } from "./continuous-operation.fixture"
import type { SourceIntegrationSummary } from "./source-integration-contract"

function setup() {
  const value = fixture(
    operation({
      cycleLimit: 2,
      sourceIntegrationPolicy: { mode: "worktree", branch: "main", head: "a".repeat(40) },
    }),
  )
  const integrateSource = vi.fn(
    async (
      _operation: Operation,
      previous: ContinuousBaseline,
      next: ContinuousBaseline,
    ): Promise<SourceIntegrationSummary> => ({
      phase: "applied",
      missionId: next.missionId ?? "missing",
      branch: "main",
      sourceHead: "a".repeat(40),
      previousTree: previous.baselineTree,
      nextTree: next.baselineTree,
      paths: ["src/main.ts"],
      at: timestamp,
    }),
  )
  const ports = { ...value.ports, integrateSource }
  return { ...value, ports, integrateSource }
}

describe("continuous source application before the next cycle", () => {
  it("applies each verified delta before counting the cycle or selecting the next goal", async () => {
    const value = setup()
    value.ports.decide = vi.fn(async (parent) => {
      expect(value.integrateSource).toHaveBeenCalledTimes(parent.completedCycles)
      return {
        action: "execute" as const,
        goal: `Improve ${parent.completedCycles}`,
        reason: "gap",
        evidence: [String(parent.completedCycles)],
      }
    })
    await runContinuousOperation(value.record, value.ports)
    expect(value.integrateSource).toHaveBeenCalledTimes(2)
    expect(value.record).toMatchObject({ phase: "completed", completedCycles: 2 })
    expect(value.record.history.every((entry) => entry.sourceIntegration?.phase === "applied")).toBe(true)
    expect(value.integrateSource.mock.calls[1]?.[1].missionId).toBe(value.record.history[0]?.missionId)
  })

  it("retains a verified child on source conflict and retries application without rerunning work", async () => {
    const value = setup()
    value.record.cycleLimit = 1
    value.integrateSource.mockRejectedValueOnce(new Error("Source file changed; preserve local edits"))
    await runContinuousOperation(value.record, value.ports)
    expect(value.record).toMatchObject({ phase: "paused", completedCycles: 0 })
    expect(value.record.currentMissionId).toBeDefined()
    expect(value.record.baseline).toEqual(baseline())
    expect(value.ports.decide).toHaveBeenCalledOnce()
    await runContinuousOperation(value.record, value.ports)
    expect(value.record).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(value.ports.runMission).toHaveBeenCalledOnce()
    expect(value.integrateSource).toHaveBeenCalledTimes(2)
  })

  it("does not silently count a local-apply cycle when its adapter is missing", async () => {
    const value = setup()
    await runContinuousOperation(value.record, { ...value.ports, integrateSource: undefined })
    expect(value.record).toMatchObject({ phase: "paused", completedCycles: 0 })
    expect(value.record.error).toContain("source")
  })

  it.each(["missionId", "branch", "sourceHead", "previousTree", "nextTree"] as const)(
    "rejects an application receipt bound to a different %s",
    async (key) => {
      const value = setup()
      const integrate = value.integrateSource.getMockImplementation()
      value.integrateSource.mockImplementation(async (...args) => {
        const summary = await integrate?.(...args)
        return {
          ...summary,
          [key]: ["missionId", "branch"].includes(key) ? "other" : "f".repeat(40),
        } as SourceIntegrationSummary
      })
      await runContinuousOperation(value.record, value.ports)
      expect(value.record).toMatchObject({ phase: "paused", completedCycles: 0 })
    },
  )

  it("retains the snapshot-only behavior for saved operations without the new policy", async () => {
    const value = setup()
    delete value.record.sourceIntegrationPolicy
    await runContinuousOperation(value.record, value.ports)
    expect(value.integrateSource).not.toHaveBeenCalled()
    expect(value.record.completedCycles).toBe(2)
  })
  it("does not count or select another goal after cancellation during source application", async () => {
    const value = setup()
    const controller = new AbortController()
    const apply = value.integrateSource.getMockImplementation()
    value.integrateSource.mockImplementation(async (...args) => {
      if (!apply) throw new Error("Missing fixture adapter")
      const result = await apply(...args)
      controller.abort()
      return result
    })
    await runContinuousOperation(value.record, { ...value.ports, signal: controller.signal })
    expect(value.record).toMatchObject({ phase: "paused", completedCycles: 0, pauseKind: "interrupted" })
    expect(value.ports.decide).toHaveBeenCalledOnce()
    expect(value.record.currentMissionId).toBeDefined()
  })
  it("requires parent policy reconciliation when a child independently used commit and push delivery", async () => {
    const value = setup()
    value.record.cycleLimit = 1
    const run = value.ports.runMission
    value.ports.runMission = vi.fn(async (parent: Operation, id: string, goal: string, path: string) => {
      const child = await run(parent, id, goal, path)
      child.codeDelivery = codeDeliverySchema.parse({
        policy: {
          branch: "main",
          remote: "origin",
          paths: ["src/main.ts"],
          message: "fix: approved",
          baseSha: "a".repeat(40),
        },
        phase: "pushed",
        attempts: 1,
        nonce: "11111111-1111-4111-8111-111111111111",
        treeSha: "b".repeat(40),
        patchSha256: "c".repeat(64),
        verifiedFingerprint: "d".repeat(64),
        commitSha: "e".repeat(40),
        updatedAt: timestamp,
      })
      return child
    })
    await runContinuousOperation(value.record, value.ports)
    expect(value.record).toMatchObject({ phase: "paused", completedCycles: 0 })
    expect(value.record.error).toContain("--source-integration snapshot-only")
    expect(value.integrateSource).not.toHaveBeenCalled()
    value.record.sourceIntegrationPolicy = { mode: "snapshot-only" }
    await runContinuousOperation(value.record, value.ports)
    expect(value.record).toMatchObject({ phase: "completed", completedCycles: 1 })
    expect(value.ports.runMission).toHaveBeenCalledOnce()
  })
})
