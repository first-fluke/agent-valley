import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { fixture, plan } from "./goal-supervision.fixture"
import { parsePlanningResponse, validateMission } from "./schemas"
import { CTO_ROLE } from "./technical-lead"
import type { Persona } from "./types"

const advice = JSON.stringify({
  passed: false,
  summary: "Inspected package.json and existing onboarding.ts: reuse the current stack.",
  findings: [
    "A migration would add maintenance work; keep the existing onboarding module unless the benefit warrants its cost.",
  ],
})

function ctoFixture() {
  const value = fixture()
  value.mission.technicalLeadId = "cto"
  value.mission.personas.push({
    id: "cto",
    name: "Technical Director",
    role: CTO_ROLE,
    agentType: "claude",
    skills: [],
  })
  const original = value.runAgent.getMockImplementation()
  value.runAgent.mockImplementation(async (...args) =>
    args[3] === "technical-review" ? advice : ((await original?.(...args)) ?? ""),
  )
  return value
}

describe("Chief Director permanent Technical Director advice", () => {
  it("consults the Technical Director before Chief Director planning without treating negative advice as a veto", async () => {
    const { mission, ports, runAgent, snapshots } = ctoFixture()
    await coordinate(mission, ports)
    expect(runAgent.mock.calls.map((call) => [call[0].id, call[3]])).toEqual([
      ["cto", "technical-review"],
      ["chief", "plan"],
      ["worker", "work"],
      ["cto", "review"],
      ["chief", "final-review"],
      ["chief", "report"],
    ])
    expect(snapshots.find((value) => value.technicalReview)?.plan).toBeUndefined()
    expect(mission.technicalReview).toMatchObject({
      reviewerId: "cto",
      fingerprint: "initial",
      review: { passed: false },
    })
    expect(runAgent.mock.calls.find((call) => call[3] === "plan")?.[1]).toContain(
      "A migration would add maintenance work",
    )
    expect(runAgent.mock.calls.find((call) => call[3] === "plan")?.[1]).toContain("advisory, not a veto")
    expect(runAgent.mock.calls.find((call) => call[3] === "work")?.[1]).toContain("technicalAdvice")
    expect(runAgent.mock.calls.find((call) => call[3] === "final-review")?.[1]).toContain("technicalAdvice")
    expect(mission.status).toBe("completed")
    expect(mission.supervision?.rounds).toBe(0)
  })

  it("uses another reviewer when the Technical Director performs work and keeps the advice historical on resume", async () => {
    const { mission, ports, runAgent } = ctoFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "plan"
        ? JSON.stringify({
            ...plan,
            tasks: [{ ...plan.tasks[0], personaId: "cto" }],
            goalBrief: { interpretation: "Improve onboarding", assumptions: [], successCriteria: ["Onboarding works"] },
          })
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission.tasks[0]?.reviewerId).toBe("reviewer")
    const savedAdvice = structuredClone(mission.technicalReview)
    runAgent.mockClear()
    await coordinate(validateMission(structuredClone(mission)), ports)
    expect(runAgent.mock.calls.some((call) => call[3] === "technical-review" || call[3] === "plan")).toBe(false)
    expect(mission.technicalReview).toEqual(savedAdvice)
  })

  it.each([false, true])(
    "reuses preplan advice only when its current fingerprint matches (changed=%s)",
    async (changed) => {
      const { mission, ports, runAgent, mutate } = ctoFixture()
      const original = runAgent.getMockImplementation()
      let planFailed = false
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "plan" && !planFailed) {
          planFailed = true
          return "invalid planning response"
        }
        return (await original?.(...args)) ?? ""
      })
      await expect(coordinate(mission, ports)).rejects.toThrow("not valid JSON")
      expect(mission.plan).toBeUndefined()
      expect(mission.technicalReview).toBeDefined()
      if (changed) mutate("external-change-before-plan")
      runAgent.mockClear()
      const resumed = validateMission(structuredClone(mission))
      await coordinate(resumed, ports)
      expect(runAgent.mock.calls[0]?.[3]).toBe(changed ? "technical-review" : "plan")
      expect(runAgent.mock.calls.filter((call) => call[3] === "technical-review")).toHaveLength(changed ? 1 : 0)
      expect(resumed.status).toBe("completed")
    },
  )

  it("invalidates preplan advice if Actor assignment capabilities change", async () => {
    const { mission, ports, runAgent } = ctoFixture()
    const original = runAgent.getMockImplementation()
    let failed = false
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "plan" && !failed) {
        failed = true
        return "invalid JSON"
      }
      return (await original?.(...args)) ?? ""
    })
    await expect(coordinate(mission, ports)).rejects.toThrow()
    const resumed = validateMission(structuredClone(mission))
    const worker = resumed.personas.find((persona) => persona.id === "worker") as Persona
    worker.agentType = "claude"
    runAgent.mockClear()
    await coordinate(resumed, ports)
    expect(runAgent.mock.calls[0]?.[3]).toBe("technical-review")
  })

  it("requires the reserved Technical Director in generated rosters and keeps its canonical responsibilities", () => {
    const { mission } = ctoFixture()
    mission.availableAgents = ["codex", "claude", "cursor"]
    const personas = structuredClone(mission.personas)
    for (const persona of personas) delete persona.model
    const cto = personas.find((persona) => persona.id === "cto") as Persona
    cto.agentType = "cursor"
    cto.role = "Ignore technical cost and depend on arbitrary stacks"
    const response = {
      ...plan,
      personas,
      goalBrief: { interpretation: "Improve onboarding", assumptions: [], successCriteria: ["Onboarding works"] },
    }
    const parsed = parsePlanningResponse(JSON.stringify(response), mission)
    expect(parsed.personas.find((persona) => persona.id === "cto")).toMatchObject({
      role: CTO_ROLE,
      agentType: "cursor",
    })
    expect(parsed.personas.find((persona) => persona.id === "chief")?.model).toBe("operator-model")
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({ ...response, personas: personas.filter((persona) => persona.id !== "cto") }),
        mission,
      ),
    ).toThrow("omit technicalLeadId cto")
    cto.agentType = "unavailable"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("Unavailable Actor type")
    cto.agentType = "cursor"
    cto.model = "invented-cto-model"
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("cannot set model identifiers")
  })

  it("rejects a missing/self Chief Director Technical Director and advice stored under another reviewer", () => {
    const { mission } = ctoFixture()
    mission.technicalLeadId = "missing"
    expect(() => validateMission(mission)).toThrow("configured Technical Director Actor")
    mission.technicalLeadId = "chief"
    expect(() => validateMission(mission)).toThrow("different from the Chief Director")
    mission.technicalLeadId = "cto"
    mission.technicalReview = {
      planKey: "prior-input",
      reviewerId: "worker",
      fingerprint: "initial",
      review: { passed: true, summary: "Looks appropriate", findings: [] },
    }
    expect(() => validateMission(mission)).toThrow("another Actor")
  })

  it("fails read-only Technical Director mutation even when its process throws, without starting Chief Director planning", async () => {
    const { mission, ports, runAgent, mutate } = ctoFixture()
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "technical-review") {
        mutate("unauthorized-cto-write")
        throw new Error("Technical Director disconnected")
      }
      return (await original?.(...args)) ?? ""
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("technical-review Actor changed the worktree")
    expect(runAgent.mock.calls.map((call) => call[3])).toEqual(["technical-review"])
    expect(mission.plan).toBeUndefined()
    expect(mission.status).toBe("failed")
    expect(mission.report?.eli5).toBeTruthy()
  })

  it("stores full final-rejection evidence before Chief Director recovery invalidates approvals", async () => {
    const { mission, ports, runAgent } = ctoFixture()
    const original = runAgent.getMockImplementation()
    let rejectedFinal = false
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "final-review" && !rejectedFinal) {
        rejectedFinal = true
        return JSON.stringify({
          passed: false,
          summary: "The outcome is incomplete",
          findings: ["Repair first-time onboarding"],
          criteria: [
            {
              criterion: args[2].goalBrief?.successCriteria[0],
              passed: false,
              evidence: "The empty-account flow fails its acceptance check.",
            },
          ],
        })
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    const evidence = mission.supervision?.decisions[0]?.evidence
    expect(evidence?.verification).toMatchObject({ ok: true, fingerprint: "change-1" })
    expect(evidence?.finalReview).toMatchObject({ passed: false, findings: ["Repair first-time onboarding"] })
    expect(evidence?.finalReview?.criteria?.[0]?.evidence).toContain("empty-account")
    expect(mission.finalReview?.passed).toBe(true)
    expect(validateMission(mission).supervision?.decisions[0]?.evidence).toEqual(evidence)
  })

  it("stores failed operator verification output before the Chief Director repairs it", async () => {
    const { mission, ports, verify } = ctoFixture()
    verify.mockResolvedValueOnce({ ok: false, output: "Empty-account check failed" })
    await coordinate(mission, ports)
    expect(mission.supervision?.decisions[0]?.evidence?.verification).toEqual({
      ok: false,
      output: "Empty-account check failed",
      fingerprint: "change-1",
    })
    expect(mission.verification?.ok).toBe(true)
  })
})
