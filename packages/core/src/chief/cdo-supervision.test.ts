import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { CDO_ROLE } from "./design-lead"
import { brief, fixture, passed, plan } from "./goal-supervision.fixture"
import { parsePlanningResponse, validateMission } from "./schemas"
import { CTO_ROLE } from "./technical-lead"
import type { Persona } from "./types"

const advice = JSON.stringify({
  passed: false,
  summary: "Observed the existing onboarding journey; no retention analytics were supplied.",
  findings: [
    "Test a shorter first-time journey with multiple user personas. Retention impact is a hypothesis, not a measured result.",
  ],
})

function cdoFixture() {
  const value = fixture()
  value.mission.technicalLeadId = "cto"
  value.mission.designLeadId = "cdo"
  value.mission.personas.push(
    { id: "cto", name: "Technical Director", role: CTO_ROLE, agentType: "claude", skills: [] },
    { id: "cdo", name: "Design Director", role: CDO_ROLE, agentType: "cursor", skills: [] },
  )
  const original = value.runAgent.getMockImplementation()
  value.runAgent.mockImplementation(async (...args) =>
    args[3] === "technical-review"
      ? passed
      : args[3] === "design-review"
        ? advice
        : ((await original?.(...args)) ?? ""),
  )
  return value
}

describe("Chief Director permanent Design Director advice", () => {
  it("consults Technical Director then Design Director before Chief Director planning and keeps both advisories nonbinding", async () => {
    const { mission, ports, runAgent, snapshots } = cdoFixture()
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.map((call) => [call[0].id, call[3]])).toEqual([
      ["cto", "technical-review"],
      ["cdo", "design-review"],
      ["chief", "plan"],
      ["worker", "work"],
      ["cto", "review"],
      ["chief", "final-review"],
      ["chief", "report"],
    ])
    expect(snapshots.find((value) => value.designReview)?.plan).toBeUndefined()
    expect(mission.designReview).toMatchObject({ reviewerId: "cdo", fingerprint: "initial", review: { passed: false } })
    const planning = runAgent.mock.calls.find((call) => call[3] === "plan")?.[1]
    expect(planning).toContain("technicalAdvice")
    expect(planning).toContain("designAdvice")
    expect(planning).toContain("Retention impact is a hypothesis")
    expect(planning).toContain("enjoys using dark patterns")
    expect(planning).toContain("never invent field tests, metrics or user reactions")
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[1]).toContain("designAdvice")
    expect(runAgent.mock.calls.find((call) => call[3] === "final-review")?.[1]).toContain("designAdvice")
    expect(mission.status).toBe("completed")
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("allows the Chief Director to assign real usability work to Design Director with an independent Technical Director reviewer", async () => {
    const { mission, ports, runAgent } = cdoFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "plan"
        ? JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], personaId: "cdo" }], goalBrief: brief })
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[0]).toMatchObject({ id: "cdo", role: CDO_ROLE })
    expect(mission.tasks[0]?.reviewerId).toBe("cto")
    expect(mission.tasks[0]?.reviewerId).not.toBe("cdo")
  })

  it.each([false, true])(
    "reuses both preplan advisories only for matching worktree evidence (changed=%s)",
    async (changed) => {
      const { mission, ports, runAgent, mutate } = cdoFixture()
      const original = runAgent.getMockImplementation()
      let failed = false
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "plan" && !failed) {
          failed = true
          return "invalid plan"
        }
        return (await original?.(...args)) ?? ""
      })
      await expect(coordinate(mission, ports)).rejects.toThrow("not valid JSON")
      if (changed) mutate("external-change")
      runAgent.mockClear()
      const resumed = validateMission(structuredClone(mission))
      await coordinate(resumed, ports)
      const stages = runAgent.mock.calls.map((call) => call[3])
      expect(stages.slice(0, changed ? 3 : 1)).toEqual(
        changed ? ["technical-review", "design-review", "plan"] : ["plan"],
      )
      expect(resumed.status).toBe("completed")
    },
  )

  it("retains both reserved companion ids and canonical roles across automatic planning", () => {
    const { mission } = cdoFixture()
    mission.availableAgents = ["codex", "claude", "cursor"]
    const personas = structuredClone(mission.personas)
    for (const persona of personas) {
      delete persona.model
      if (persona.id === "cto" || persona.id === "cdo") persona.role = "Invented responsibility"
    }
    const response = { ...plan, personas, goalBrief: brief }
    const parsed = parsePlanningResponse(JSON.stringify(response), mission)
    expect(parsed.personas.find((persona) => persona.id === "cto")?.role).toBe(CTO_ROLE)
    expect(parsed.personas.find((persona) => persona.id === "cdo")?.role).toBe(CDO_ROLE)
    expect(parsed.personas.find((persona) => persona.id === "chief")?.model).toBe("operator-model")
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({ ...response, personas: personas.filter((persona) => persona.id !== "cdo") }),
        mission,
      ),
    ).toThrow("omit designLeadId cdo")
    const cdo = personas.find((persona) => persona.id === "cdo") as Persona
    cdo.model = "invented-designer-model"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("cannot set model identifiers")
    delete cdo.model
    cdo.agentType = "unavailable"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("Unavailable Actor type")
  })

  it("rejects Design Director aliases to Chief Director/Technical Director, missing Actors and mismatched saved advice", () => {
    const { mission } = cdoFixture()
    for (const id of ["chief", "cto", "missing"]) {
      mission.designLeadId = id
      expect(() => validateMission(mission)).toThrow("configured Design Director different")
    }
    mission.designLeadId = "cdo"
    mission.designReview = {
      planKey: "prior-input",
      reviewerId: "cto",
      fingerprint: "initial",
      review: { passed: true, summary: "Advice", findings: [] },
    }
    expect(() => validateMission(mission)).toThrow("another Actor")
  })

  it.each([false, true])(
    "fails unsafe design-advice edits before planning even with process failure=%s",
    async (throws) => {
      const { mission, ports, runAgent, mutate } = cdoFixture()
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "design-review") {
          mutate("unauthorized-design-edit")
          if (throws) throw new Error("Design Director disconnected")
          return advice
        }
        return (await original?.(...args)) ?? ""
      })
      await expect(coordinate(mission, ports)).rejects.toThrow("design-review Actor changed the worktree")
      expect(runAgent.mock.calls.map((call) => call[3])).toEqual(["technical-review", "design-review"])
      expect(mission.plan).toBeUndefined()
      expect(mission.status).toBe("failed")
      expect(mission.report?.eli5).toBeTruthy()
    },
  )

  it("keeps Technical Director/Design Director advice historical once a plan is saved and does not rediscover it on resume", async () => {
    const { mission, ports, runAgent } = cdoFixture()
    await coordinate(mission, ports)
    const resumed = validateMission(structuredClone(mission))
    const before = { technical: resumed.technicalReview, design: resumed.designReview }
    runAgent.mockClear()
    await coordinate(resumed, ports)
    expect(
      runAgent.mock.calls.some(
        (call) => call[3] === "technical-review" || call[3] === "design-review" || call[3] === "plan",
      ),
    ).toBe(false)
    expect(resumed.technicalReview).toEqual(before.technical)
    expect(resumed.designReview).toEqual(before.design)
  })
})
