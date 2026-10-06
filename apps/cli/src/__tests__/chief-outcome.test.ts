import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import type { MissionStatus } from "@agent-valley/core/chief/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { orderExitCode, printOrderOutcome } from "../chief-outcome"

afterEach(() => vi.restoreAllMocks())

describe("order result contract", () => {
  it.each([
    ["completed", 0],
    ["failed", 1],
    ["pending", 2],
    ["planning", 2],
    ["executing", 2],
    ["reviewing", 2],
    ["verifying", 2],
    ["waiting", 2],
    ["paused", 2],
  ] satisfies Array<[MissionStatus, number]>)("maps %s to shell outcome %s", (status, exitCode) => {
    const mission = missionFixture()
    mission.status = status
    expect(orderExitCode(mission)).toBe(exitCode)
  })

  it("reports a checkpoint's failure reason without handing repair decisions to the user", () => {
    const mission = missionFixture()
    mission.status = "failed"
    mission.error = "Acceptance command rejected the deliverable"
    mission.execution = {
      startedAt: new Date().toISOString(),
      runsStarted: 3,
      retries: 0,
      pauseReason: "Earlier provider outage",
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    printOrderOutcome(mission)
    const output = log.mock.calls.flat().join("\n")
    expect(output).toContain(mission.error)
    expect(output).toContain(`Report: .agent-valley/reports/${mission.id}.md`)
    expect(output).not.toContain("--retry")
    expect(output).not.toContain(mission.finalReview?.summary)
    expect(output).not.toContain("Earlier provider outage")
  })

  it("explains an unresolved active checkpoint and points to its report", () => {
    const mission = missionFixture()
    mission.status = "executing"
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    printOrderOutcome(mission)
    expect(log.mock.calls.flat().join("\n")).toContain("The goal has not reached verified completion")
    expect(log).toHaveBeenLastCalledWith(`Report: .agent-valley/reports/${mission.id}.md`)
  })
})
