import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { CDO_ROLE } from "./design-lead"
import { brief, fixture, passed, plan } from "./goal-supervision.fixture"
import { CMO_ROLE } from "./marketing-lead"
import { parsePlanningResponse, validateMission } from "./schemas"
import { CTO_ROLE } from "./technical-lead"
import type { Persona } from "./types"

const advice = JSON.stringify({
  passed: false,
  summary: "Inspected onboarding and documentation; CAC, LTV and revenue measurements are unavailable.",
  findings: [
    "Experiment with a shorter onboarding guide as an indirect acquisition channel. Conversion and ROI are hypotheses until measured.",
  ],
})

function cmoFixture() {
  const value = fixture()
  value.mission.technicalLeadId = "cto"
  value.mission.designLeadId = "cdo"
  value.mission.marketingLeadId = "cmo"
  value.mission.personas.push(
    { id: "cto", name: "Technical Director", role: CTO_ROLE, agentType: "claude", skills: [] },
    { id: "cdo", name: "Design Director", role: CDO_ROLE, agentType: "cursor", skills: [] },
    { id: "cmo", name: "Marketing Director", role: CMO_ROLE, agentType: "codex", skills: [] },
  )
  const original = value.runAgent.getMockImplementation()
  value.runAgent.mockImplementation(async (...args) =>
    args[3] === "technical-review" || args[3] === "design-review"
      ? passed
      : args[3] === "marketing-review"
        ? advice
        : ((await original?.(...args)) ?? ""),
  )
  return value
}

describe("Chief Director permanent Marketing Director advice", () => {
  it("consults Technical Director, Design Director and Marketing Director before planning without vetoing the Chief Director for missing marketing data", async () => {
    const { mission, ports, runAgent, snapshots } = cmoFixture()
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.map((call) => [call[0].id, call[3]])).toEqual([
      ["cto", "technical-review"],
      ["cdo", "design-review"],
      ["cmo", "marketing-review"],
      ["chief", "plan"],
      ["worker", "work"],
      ["cto", "review"],
      ["chief", "final-review"],
      ["chief", "report"],
    ])
    expect(snapshots.find((value) => value.marketingReview)?.plan).toBeUndefined()
    expect(mission.marketingReview).toMatchObject({
      reviewerId: "cmo",
      fingerprint: "initial",
      review: { passed: false },
    })
    const planning = runAgent.mock.calls.find((call) => call[3] === "plan")?.[1]
    expect(planning).toContain("marketingAdvice")
    expect(planning).toContain("Conversion and ROI are hypotheses")
    expect(planning).toContain("Never invent revenue")
    expect(planning).toContain("profitable direct and indirect channels")
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[1]).toContain("marketingAdvice")
    expect(runAgent.mock.calls.find((call) => call[3] === "final-review")?.[1]).toContain("marketingAdvice")
    expect(mission.status).toBe("completed")
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("lets the Chief Director assign real marketing work to Marketing Director and preserves an independent Technical Director reviewer", async () => {
    const { mission, ports, runAgent } = cmoFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "plan"
        ? JSON.stringify({ ...plan, tasks: [{ ...plan.tasks[0], personaId: "cmo" }], goalBrief: brief })
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[0]).toMatchObject({ id: "cmo", role: CMO_ROLE })
    expect(mission.tasks[0]?.reviewerId).toBe("cto")
    expect(mission.tasks[0]?.reviewerId).not.toBe("cmo")
  })

  it.each([false, true])(
    "reuses all preplan advice only for matching worktree fingerprints (changed=%s)",
    async (changed) => {
      const { mission, ports, runAgent, mutate } = cmoFixture()
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
      expect(runAgent.mock.calls.slice(0, changed ? 4 : 1).map((call) => call[3])).toEqual(
        changed ? ["technical-review", "design-review", "marketing-review", "plan"] : ["plan"],
      )
      expect(resumed.status).toBe("completed")
    },
  )

  it("keeps all three reserved canonical roles and accepts a four-person automatic team", () => {
    const { mission } = cmoFixture()
    mission.availableAgents = ["codex", "claude", "cursor"]
    const personas = structuredClone(
      mission.personas.filter((persona) => ["chief", "cto", "cdo", "cmo"].includes(persona.id)),
    )
    for (const persona of personas) {
      delete persona.model
      if (persona.id !== "chief") persona.role = "Generated expertise"
    }
    const response = { personas, tasks: [{ ...plan.tasks[0], personaId: "cmo" }], goalBrief: brief }
    const parsed = parsePlanningResponse(JSON.stringify(response), mission)
    expect(parsed.personas).toHaveLength(4)
    expect(parsed.personas.find((persona) => persona.id === "cto")?.role).toBe(CTO_ROLE)
    expect(parsed.personas.find((persona) => persona.id === "cdo")?.role).toBe(CDO_ROLE)
    expect(parsed.personas.find((persona) => persona.id === "cmo")?.role).toBe(CMO_ROLE)
    expect(parsed.personas.find((persona) => persona.id === "chief")?.model).toBe("operator-model")
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({ ...response, personas: personas.filter((persona) => persona.id !== "cmo") }),
        mission,
      ),
    ).toThrow()
    const cmo = personas.find((persona) => persona.id === "cmo") as Persona
    cmo.model = "invented-marketing-model"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("cannot set model identifiers")
    delete cmo.model
    cmo.agentType = "unavailable"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("Unavailable Actor type")
  })

  it("rejects aliases to other leaders, missing Marketing Director and mismatched saved marketing advice", () => {
    const { mission } = cmoFixture()
    for (const id of ["chief", "cto", "cdo", "missing"]) {
      mission.marketingLeadId = id
      expect(() => validateMission(mission)).toThrow("configured Marketing Director different")
    }
    mission.marketingLeadId = "cmo"
    mission.marketingReview = {
      planKey: "prior-input",
      reviewerId: "cdo",
      fingerprint: "initial",
      review: { passed: true, summary: "Advice", findings: [] },
    }
    expect(() => validateMission(mission)).toThrow("another Actor")
  })

  it.each([false, true])(
    "fails unsafe marketing-advice edits before Chief Director planning with process failure=%s",
    async (throws) => {
      const { mission, ports, runAgent, mutate } = cmoFixture()
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "marketing-review") {
          mutate("unauthorized-marketing-edit")
          if (throws) throw new Error("Marketing Director disconnected")
          return advice
        }
        return (await original?.(...args)) ?? ""
      })
      await expect(coordinate(mission, ports)).rejects.toThrow("marketing-review Actor changed the worktree")
      expect(runAgent.mock.calls.map((call) => call[3])).toEqual([
        "technical-review",
        "design-review",
        "marketing-review",
      ])
      expect(mission.plan).toBeUndefined()
      expect(mission.status).toBe("failed")
      expect(mission.report?.eli5).toBeTruthy()
    },
  )

  it("treats marketing advice as historical after planning and skips all advisor rediscovery on resume", async () => {
    const { mission, ports, runAgent } = cmoFixture()
    await coordinate(mission, ports)
    const resumed = validateMission(structuredClone(mission))
    const before = structuredClone(resumed.marketingReview)
    runAgent.mockClear()
    await coordinate(resumed, ports)
    expect(
      runAgent.mock.calls.some((call) =>
        ["technical-review", "design-review", "marketing-review", "plan"].includes(call[3]),
      ),
    ).toBe(false)
    expect(resumed.marketingReview).toEqual(before)
  })
})
