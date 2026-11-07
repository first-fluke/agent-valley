import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { runCommand } from "../workspace/worktree-lifecycle"
import { fingerprintWorkspace } from "./fingerprint"
import {
  getOrganizationRouteEvidence,
  listOrganizationOutcomes,
  recordMissionOrganizationOutcome,
  recordOrganizationOutcome,
} from "./organization"
import { routingCancellationFixture } from "./routing-cancellation.fixture"

vi.mock("./fingerprint", () => ({ fingerprintWorkspace: vi.fn() }))
vi.mock("../workspace/worktree-lifecycle", () => ({ runCommand: vi.fn() }))
const fingerprint = "a".repeat(64)
let directory: string
let source: string
let workspace: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-routing-cancellation-"))
  source = join(directory, "source")
  workspace = join(directory, "workspace")
  await Promise.all([mkdir(source), mkdir(workspace)])
  await writeFile(join(workspace, "output.md"), "Retained product work")
  vi.resetAllMocks()
  vi.mocked(fingerprintWorkspace).mockResolvedValue(fingerprint)
  vi.mocked(runCommand).mockResolvedValue({ exitCode: 0, stdout: "output.md\0", stderr: "" })
})
afterEach(async () => rm(directory, { recursive: true, force: true }))

describe("cancellation proof in organization routing evidence", () => {
  it.each([0.25, null])(
    "archives framework cancellation proof without changing native usage, preserving cost %s across the next cycle",
    async (costUsd) => {
      const { mission, run } = routingCancellationFixture()
      mission.status = "failed"
      mission.workspace.path = workspace
      run.costUsd = costUsd
      mission.operations?.runs.unshift({
        ...run,
        runId: "accepted-work",
        taskId: "earlier-task",
        startedAt: "2026-11-08T04:40:00Z",
        finishedAt: "2026-11-08T04:41:00Z",
        outcome: "passed",
        costUsd: 0.1,
      })
      const before = structuredClone(mission)

      const archived = await recordMissionOrganizationOutcome(source, mission)
      const saved = (await listOrganizationOutcomes(source))[0]
      const cancelled = saved?.runs.find((entry) => entry.runId === run.runId)
      expect(cancelled).toEqual({
        ...run,
        routingExclusion: {
          reason: "coordinator-cancelled",
          dispatchAt: "2026-11-08T05:00:27.694Z",
          pauseAt: "2026-11-08T05:12:35.010Z",
        },
      })
      expect(archived.runs.find((entry) => entry.runId === "accepted-work")?.routingExclusion).toBeUndefined()
      expect(mission).toEqual(before)
      const nextCycle = await getOrganizationRouteEvidence(source)
      expect(nextCycle).toHaveLength(1)
      expect(nextCycle[0]).toMatchObject({ actorType: "opencode", samples: 1, successes: 1 })
      if (costUsd === null) {
        expect(nextCycle[0]?.totalCostUsd).toBeNull()
        expect(nextCycle[0]?.successfulDeliverableCostUsd).toBeNull()
      } else {
        expect(nextCycle[0]?.totalCostUsd).toBeCloseTo(0.35)
        expect(nextCycle[0]?.successfulDeliverableCostUsd).toBeCloseTo(0.35)
      }
    },
  )

  it("does not reinterpret legacy failed records or cancellation prose without explicit per-run proof", async () => {
    const { run } = routingCancellationFixture()
    await recordOrganizationOutcome(source, {
      missionId: "legacy-mission",
      missionVersion: "original-version",
      fingerprint,
      workspacePath: workspace,
      goal: "Original goal",
      status: "failed",
      summary: "Operator interrupted the mission",
      evidence: [],
      runs: [run],
    })

    expect(await getOrganizationRouteEvidence(source)).toMatchObject([{ samples: 1, successes: 0, totalCostUsd: null }])
    expect((await listOrganizationOutcomes(source))[0]?.runs[0]).toEqual(run)
  })

  it.each(["actual-rejection", "nonlocal-failure", "unknown-outcome", "out-of-bounds-proof", "native-crash-evidence"])(
    "retains real failure samples despite an inapplicable cancellation annotation: %s",
    async (condition) => {
      const { run } = routingCancellationFixture()
      run.routingExclusion = {
        reason: "coordinator-cancelled",
        dispatchAt: "2026-11-08T05:00:27.694Z",
        pauseAt: "2026-11-08T05:12:35.010Z",
      }
      if (condition === "actual-rejection") run.outcome = "rejected"
      if (condition === "nonlocal-failure") run.executionRecovery = "reconcile"
      if (condition === "unknown-outcome") run.executionState = "unknown"
      if (condition === "out-of-bounds-proof") run.routingExclusion.pauseAt = "2026-11-08T05:00:00Z"
      if (condition === "native-crash-evidence") run.evidence = "Native process exited with code 1"
      await recordOrganizationOutcome(source, {
        missionId: "real-failure",
        missionVersion: condition,
        fingerprint,
        workspacePath: workspace,
        goal: "Original goal",
        status: "failed",
        summary: "A real failed run",
        evidence: [],
        runs: [run],
      })
      expect(await getOrganizationRouteEvidence(source)).toMatchObject([{ samples: 1, successes: 0 }])
    },
  )

  it("keeps confirmed native timeouts out of cross-cycle quality samples without erasing their cost", async () => {
    const { run } = routingCancellationFixture()
    run.evidence = "Agent timed out after 1800s"
    run.costUsd = 0.25
    await recordOrganizationOutcome(source, {
      missionId: "timeout-mission",
      missionVersion: "timeout",
      fingerprint,
      workspacePath: workspace,
      goal: "Original goal",
      status: "failed",
      summary: "The Actor hit its deadline",
      evidence: [],
      runs: [run],
    })
    expect(await getOrganizationRouteEvidence(source)).toMatchObject([
      { samples: 0, successes: 0, totalCostUsd: 0.25, successfulDeliverableCostUsd: null },
    ])
  })
})
