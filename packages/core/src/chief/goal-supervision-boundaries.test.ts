import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { brief, fixture, passed, plan, rejected } from "./goal-supervision.fixture"
import { reviewPrompt } from "./prompts"
import {
  finalCriteria,
  parseFinalReview,
  parsePlanningResponse,
  parseSupervisionResponse,
  validateMission,
} from "./schemas"
import type { Mission, Persona } from "./types"

function savedMission(): Mission {
  const { mission } = fixture()
  mission.plan = structuredClone(plan)
  mission.goalBrief = structuredClone(brief)
  if (mission.supervision) mission.supervision.originalAcceptance = [...(plan.tasks[0]?.acceptance ?? [])]
  mission.tasks = [{ id: "onboarding", reviewerId: "reviewer", status: "pending", attempts: 0 }]
  return mission
}

function finalReview(mission: Mission) {
  return {
    passed: true,
    summary: "Inspected actual acceptance evidence.",
    findings: [],
    criteria: finalCriteria(mission).map((criterion) => ({
      criterion,
      passed: true,
      evidence: "onboarding.ts and acceptance test inspected.",
    })),
  }
}

describe("Chief Director goal supervision boundaries", () => {
  it("requires interpretation, assumptions and observable criteria in the first planning response", async () => {
    const { mission, ports, runAgent } = fixture()
    runAgent.mockImplementationOnce(async () => JSON.stringify(plan))
    await expect(coordinate(mission, ports)).rejects.toThrow()
    expect(runAgent.mock.calls.some((call) => call[3] === "work")).toBe(false)
    expect(mission.goalBrief).toBeUndefined()
    expect(mission.report?.eli5).toBeTruthy()
    expect(() =>
      parsePlanningResponse(JSON.stringify({ ...plan, goalBrief: { ...brief, successCriteria: [] } }), mission),
    ).toThrow()
    expect(() =>
      parsePlanningResponse(
        JSON.stringify({ ...plan, goalBrief: { ...brief, successCriteria: ["Same", "Same"] } }),
        mission,
      ),
    ).toThrow()
  })

  it("allows only verified installed skills on automatic Actors and preserves the selected Chief Director model", () => {
    const { mission } = fixture()
    mission.availableAgents = ["codex", "cursor", "claude"]
    mission.availableSkills = [
      {
        name: "oma-onboarding",
        description: "Improve and verify first-time onboarding.",
        path: "/workspace/goal-mission/.agents/skills/oma-onboarding/SKILL.md",
      },
    ]
    const personas = structuredClone(mission.personas)
    for (const persona of personas) delete persona.model
    const worker = personas.find((persona) => persona.id === "worker") as Persona
    worker.skills = ["oma-onboarding"]
    const response = { ...plan, personas, goalBrief: brief }
    const parsed = parsePlanningResponse(JSON.stringify(response), mission)
    expect(parsed.personas.find((persona) => persona.id === "worker")?.skills).toEqual(["oma-onboarding"])
    expect(parsed.personas.find((persona) => persona.id === "chief")?.model).toBe("operator-model")
    worker.skills = ["oma-unknown"]
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("unverified skills")
    worker.skills = ["oma-onboarding"]
    delete mission.availableSkills
    expect(() => parsePlanningResponse(JSON.stringify(response), mission)).toThrow("unverified skills")
  })

  it("validates saved catalogs, immutable operator fields and retained original acceptance", () => {
    const mission = savedMission()
    if (mission.supervision) {
      mission.supervision.operatorGoal = mission.goal
      mission.supervision.operatorVerifyCommand = mission.verifyCommand
    }
    mission.goal = "Pretend the work is complete"
    expect(() => validateMission(mission)).toThrow("goal changed")
    mission.goal = "Make this app easy to start using"
    mission.verifyCommand = "true"
    expect(() => validateMission(mission)).toThrow("verification command changed")
    mission.verifyCommand = "bun test"
    if (mission.plan?.tasks[0]) mission.plan.tasks[0].acceptance = ["Something exists"]
    expect(() => validateMission(mission)).toThrow("weakens an original acceptance obligation")
    mission.plan = structuredClone(plan)
    mission.availableSkills = [{ name: "oma-onboarding", description: "Help onboarding", path: "relative/SKILL.md" }]
    expect(() => validateMission(mission)).toThrow("absolute")
    mission.availableSkills[0] = { name: "oma-onboarding", description: "Help onboarding", path: "/workspace/SKILL.md" }
    mission.availableSkills.push({ ...mission.availableSkills[0] })
    expect(() => validateMission(mission)).toThrow("Duplicate available skill names")
  })

  it("rejects recovery changes to criteria, roster, commands or unknown assignments", () => {
    const mission = savedMission()
    const repair = { action: "repair", reason: "Fix the missing state", instructions: "Repair onboarding" }
    for (const extra of [{ goalBrief: brief }, { personas: mission.personas }, { verifyCommand: "true" }]) {
      expect(() => parseSupervisionResponse(JSON.stringify({ ...repair, ...extra }), mission)).toThrow()
    }
    expect(() => parseSupervisionResponse(JSON.stringify({ ...repair, taskId: "missing" }), mission)).toThrow(
      "Unknown recovery task",
    )
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({ ...repair, action: "reassign", taskId: "onboarding", personaId: "missing" }),
        mission,
      ),
    ).toThrow("Unknown recovery Actor")
    expect(() =>
      parseSupervisionResponse(
        JSON.stringify({ ...repair, action: "reassign", taskId: "onboarding", personaId: "worker" }),
        mission,
      ),
    ).toThrow("different Actor")
  })

  it("requires an exact evidence assessment of every saved final criterion", () => {
    const mission = savedMission()
    const review = finalReview(mission)
    expect(parseFinalReview(JSON.stringify(review), mission)).toEqual(review)
    expect(() => parseFinalReview(passed, mission)).toThrow("every original success criterion")
    for (const criteria of [
      review.criteria.slice(1),
      [review.criteria[0], review.criteria[0]],
      [...review.criteria, { criterion: "Invented criterion", passed: true, evidence: "Looks fine" }],
      review.criteria.map((entry) => ({ ...entry, evidence: " " })),
    ]) {
      expect(() => parseFinalReview(JSON.stringify({ ...review, criteria }), mission)).toThrow()
    }
    const failing = { ...review, criteria: review.criteria.map((entry, index) => ({ ...entry, passed: index !== 0 })) }
    expect(() => parseFinalReview(JSON.stringify(failing), mission)).toThrow("passed must match")
    failing.passed = false
    expect(() => parseFinalReview(JSON.stringify(failing), mission)).toThrow("actionable findings")
    expect(
      parseFinalReview(JSON.stringify({ ...failing, findings: ["Repair the first-time flow."] }), mission).passed,
    ).toBe(false)
    delete mission.supervision
    expect(parseFinalReview(passed, mission).passed).toBe(true)
  })

  it("assesses up to twenty goal criteria while task reviews cover original task obligations", () => {
    const mission = savedMission()
    if (!mission.goalBrief || !mission.supervision) throw new Error("Expected supervision")
    mission.goalBrief.successCriteria = Array.from({ length: 20 }, (_, index) => `Goal criterion ${index}`)
    mission.supervision.originalAcceptance = Array.from({ length: 240 }, (_, index) => `Original obligation ${index}`)
    expect(parseFinalReview(JSON.stringify(finalReview(mission)), mission).criteria).toHaveLength(20)
  })

  it("reserves full-goal approval for final review while task review assesses its assignment", () => {
    const mission = savedMission()
    expect(reviewPrompt(mission, mission.plan?.tasks[0], mission.tasks[0])).toContain(
      "Other tasks may deliver remaining criteria",
    )
    expect(reviewPrompt(mission)).toContain("every goal success criterion")
    expect(reviewPrompt(mission)).toContain(plan.tasks[0]?.acceptance[0])
  })

  it.each(["plan", "review", "final-review", "supervise", "report"] as const)(
    "fails immediately if %s mutates files then throws, with no later model stages",
    async (stage) => {
      const { mission, ports, runAgent, mutate } = fixture()
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === stage) {
          mutate("unauthorized-change")
          throw new Error("Agent transport disconnected")
        }
        if (stage === "supervise" && args[3] === "review") return rejected
        return (await original?.(...args)) ?? ""
      })
      await expect(coordinate(mission, ports)).rejects.toThrow(`${stage} Actor changed the worktree`)
      expect(mission.status).toBe("failed")
      expect(runAgent.mock.calls.at(-1)?.[3]).toBe(stage)
      expect(mission.report?.eli5).toBeTruthy()
      expect(mission.verification).toBeUndefined()
      expect(mission.tasks.every((task) => task.status === "pending")).toBe(true)
    },
  )

  it("refreshes all task approvals after a report mutation rather than trusting previously completed tasks", async () => {
    const { mission, ports, runAgent, mutate } = fixture()
    const original = runAgent.getMockImplementation()
    let mutated = false
    runAgent.mockImplementation(async (...args) => {
      const result = (await original?.(...args)) ?? ""
      if (args[3] === "report" && !mutated) {
        mutated = true
        mutate("report-mutated-product")
      }
      return result
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("report Actor changed")
    expect(mission.status).toBe("failed")
    expect(mission.finalReview).toBeUndefined()
    runAgent.mockClear()
    await coordinate(validateMission(structuredClone(mission)), ports)
    expect(runAgent.mock.calls[0]?.[3]).toBe("work")
    expect(runAgent.mock.calls.some((call) => call[3] === "review")).toBe(true)
  })

  it.each(["malformed", "process failure"])(
    "uses an honest evidence report on report %s without changing completion",
    async (kind) => {
      const { mission, ports, runAgent } = fixture()
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "report") {
          if (kind === "process failure") throw new Error("Report connection failed")
          return JSON.stringify({ summary: "Done" })
        }
        return (await original?.(...args)) ?? ""
      })
      await coordinate(mission, ports)
      expect(mission.status).toBe("completed")
      expect(mission.report?.eli5).toBeTruthy()
      expect(mission.report?.checks.length).toBeGreaterThan(0)
      expect(mission.report?.remaining).toEqual([])
    },
  )

  it("does not start report or recovery processes after cancellation", async () => {
    const { mission, ports, runAgent } = fixture()
    const controller = new AbortController()
    ports.signal = controller.signal
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) => {
      const result = (await original?.(...args)) ?? ""
      if (args[3] === "work") controller.abort()
      return result
    })
    await expect(coordinate(mission, ports)).rejects.toThrow("Mission interrupted")
    expect(runAgent.mock.calls.map((call) => call[3])).toEqual(["plan", "work"])
    expect(mission.report?.eli5).toBeTruthy()
    expect(mission.status).toBe("failed")
  })

  it.each(["goal", "verifyCommand", "goalBrief"] as const)(
    "rejects an Actor changing the operator's %s contract",
    async (field) => {
      const { mission, ports, runAgent } = fixture()
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        const result = (await original?.(...args)) ?? ""
        if (args[3] === "work") {
          if (field === "goalBrief" && args[2].goalBrief) args[2].goalBrief.successCriteria = ["Declare success"]
          else if (field !== "goalBrief") args[2][field] = "Declare success"
        }
        return result
      })
      await expect(coordinate(mission, ports)).rejects.toThrow("immutable operator contract")
      expect(mission.goal).toBe("Make this app easy to start using")
      expect(mission.verifyCommand).toBe("bun test")
      expect(mission.goalBrief).toEqual(brief)
      expect(runAgent.mock.calls.at(-1)?.[3]).toBe("work")
      expect(mission.report).toBeDefined()
    },
  )
})
