import { describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { createMissionReporter } from "./coordinator-report"
import type { createMissionRun } from "./coordinator-run"
import { executionPolicySchema, MissionPause } from "./execution"
import { fixture as executionFixture } from "./goal-supervision.fixture"
import { mission as missionFixture } from "./reports.fixture"
import type { ChiefPorts } from "./types"

function fixture() {
  const mission = missionFixture()
  mission.status = "reviewing"
  mission.executionPolicy = executionPolicySchema.parse({ maxRuns: 4 })
  mission.execution = { startedAt: new Date().toISOString(), runsStarted: 4, retries: 0 }
  const run = vi
    .fn<ReturnType<typeof createMissionRun>>()
    .mockRejectedValue(new MissionPause("No report run allowance remains", "budget"))
  const ports: ChiefPorts = {
    runAgent: vi.fn(),
    verify: vi.fn(),
    save: vi.fn(),
    fingerprint: vi.fn(),
  }
  const persona = (id: string) => {
    const actor = mission.personas.find((entry) => entry.id === id)
    if (!actor) throw new Error("Expected Chief actor")
    return actor
  }
  return { mission, ports, run, persona }
}

describe("completion report generation", () => {
  it("renders verified evidence without another Actor call or run reservation", async () => {
    const { mission, ports, run, persona } = fixture()
    const execution = structuredClone(mission.execution)
    await createMissionReporter(mission, ports, run, persona, () => true)()
    expect(run).not.toHaveBeenCalled()
    expect(mission.execution).toEqual(execution)
    expect(mission.report).toBeDefined()
    expect(mission.status).toBe("reviewing")
  })

  it("keeps an unverified report failure fatal and never approves the Mission", async () => {
    const { mission, ports, run, persona } = fixture()
    mission.verification = undefined
    await expect(createMissionReporter(mission, ports, run, persona, () => true)()).rejects.toThrow(
      "No report run allowance",
    )
    expect(run).toHaveBeenCalledOnce()
    expect(mission.status).toBe("reviewing")
  })

  it("keeps an explicit interruption incomplete without spending another run", async () => {
    const { mission, ports, run, persona } = fixture()
    mission.status = "paused"
    mission.error = "Operator stopped execution"
    const controller = new AbortController()
    controller.abort()
    ports.signal = controller.signal
    await createMissionReporter(mission, ports, run, persona, () => true)()
    expect(run).not.toHaveBeenCalled()
    expect(mission.report?.summary).toContain("미완료")
    expect(mission.status).toBe("paused")
  })

  it("still refuses a fingerprint change after generating a verified draft", async () => {
    const { mission, ports, snapshots } = executionFixture()
    const fingerprint = ports.fingerprint
    ports.fingerprint = async (current) =>
      current.report && current.status === "reviewing" ? "late-change" : fingerprint(current)
    await expect(coordinate(mission, ports)).rejects.toThrow("Worktree changed after")
    expect(snapshots.some((saved) => saved.status === "completed")).toBe(false)
    expect(mission.status).toBe("failed")
  })

  it("keeps cancellation after the verified draft unresolved", async () => {
    const { mission, ports, snapshots } = executionFixture()
    const controller = new AbortController()
    ports.signal = controller.signal
    const fingerprint = ports.fingerprint
    ports.fingerprint = async (current) => {
      if (current.report && current.status === "reviewing") controller.abort()
      return fingerprint(current)
    }
    await expect(coordinate(mission, ports)).rejects.toThrow("Mission interrupted")
    expect(mission.status).toBe("failed")
    expect(snapshots.some((saved) => saved.status === "completed")).toBe(false)
    expect(mission.report?.summary).toContain("미완료")
  })
})
