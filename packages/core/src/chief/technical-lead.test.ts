import { describe, expect, it } from "vitest"
import { actorData, actorPlanData } from "./actor-contract"
import { CTO_ROLE, technicalPlanKey, technicalReviewPrompt } from "./technical-lead"
import type { Mission } from "./types"

function fixture(): Mission {
  return {
    id: "technical-test",
    goal: "Maintain the existing report API and improve its response time.",
    chiefId: "chief",
    technicalLeadId: "cto",
    personas: [
      {
        id: "chief",
        name: "Chief Director",
        role: "Coordinate",
        agentType: "claude",
        model: "operator-model",
        skills: [],
      },
      {
        id: "cto",
        name: "Technical Director",
        role: CTO_ROLE,
        agentType: "codex",
        skills: ["oma-architecture", "oma-qa"],
      },
      { id: "engineer", name: "Engineer", role: "Implement", agentType: "claude", skills: ["oma-backend"] },
    ],
    availableAgents: ["claude", "codex"],
    availableSkills: [
      {
        name: "oma-architecture",
        description: "Review architecture.",
        path: "/target/.agents/skills/oma-architecture/SKILL.md",
      },
    ],
    workspace: {
      issueId: "technical-test",
      path: "/target",
      key: "technical-test",
      branch: "chief/test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    goalBrief: {
      interpretation: "Improve latency while retaining the API contract.",
      assumptions: ["The current stack remains adequate."],
      successCriteria: ["The existing API contract is preserved.", "Response-time evidence improves."],
    },
    plan: {
      tasks: [
        {
          id: "inspect",
          title: "Inspect reusable response handling",
          personaId: "engineer",
          instructions: "Inspect shared response handling and record baseline evidence.",
          acceptance: ["Baseline evidence is recorded."],
          dependencies: [],
        },
        {
          id: "improve",
          title: "Improve the current implementation",
          personaId: "engineer",
          instructions: "Reuse the current response module and preserve its API contract.",
          acceptance: ["The API contract is preserved.", "Latency evidence is recorded."],
          dependencies: ["inspect"],
        },
      ],
    },
    supervision: {
      maxRounds: 4,
      rounds: 0,
      stalledRounds: 0,
      decisions: [],
      operatorGoal: "Maintain the existing report API and improve its response time.",
      operatorVerifyCommand: "bun run test:report",
    },
    verifyCommand: "bun run test:report",
    timeoutSec: 300,
    maxRepairs: 2,
    status: "planning",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
}

function chief(mission: Mission) {
  const persona = mission.personas.find((entry) => entry.id === mission.chiefId)
  if (!persona) throw new Error("Missing Chief Director fixture.")
  return persona
}

function task(mission: Mission) {
  const entry = mission.plan?.tasks[0]
  if (!entry) throw new Error("Missing plan fixture.")
  return entry
}

describe("Technical Director advisory input identity", () => {
  it("hashes canonically and survives JSON round trips and Actor presentation order", () => {
    const mission = fixture()
    const key = technicalPlanKey(mission)
    expect(key).toMatch(/^[a-f0-9]{64}$/)
    expect(technicalPlanKey(JSON.parse(JSON.stringify(mission)))).toBe(key)
    const reordered = { ...mission, personas: [...mission.personas].reverse() }
    expect(technicalPlanKey(reordered)).toBe(key)
    const first = task(reordered)
    const plan = reordered.plan
    if (!plan) throw new Error("Missing plan fixture.")
    reordered.plan = {
      tasks: [
        {
          dependencies: first.dependencies,
          acceptance: first.acceptance,
          instructions: first.instructions,
          personaId: first.personaId,
          title: first.title,
          id: first.id,
        },
        ...plan.tasks.slice(1),
      ],
    }
    expect(technicalPlanKey(reordered)).toBe(key)
  })

  it("does not change when cached advice or execution bookkeeping is saved", () => {
    const mission = fixture()
    const key = technicalPlanKey(mission)
    mission.technicalReview = {
      planKey: key,
      reviewerId: "cto",
      fingerprint: "baseline",
      review: { passed: true, summary: "Inspected current modules.", findings: [] },
    }
    mission.status = "executing"
    mission.updatedAt = "2026-10-04"
    mission.tasks = [
      {
        id: "inspect",
        reviewerId: "cto",
        status: "completed",
        attempts: 2,
        output: "Evidence",
        fingerprint: "changed",
      },
    ]
    mission.history.push({ at: "2026-10-04", stage: "technical-review", message: "Approved." })
    mission.finalReview = { passed: false, summary: "Remaining work.", findings: ["Improve evidence."] }
    expect(technicalPlanKey(mission)).toBe(key)
  })

  it.each<[string, (mission: Mission) => void]>([
    [
      "goal",
      (mission) => {
        mission.goal += " New goal."
      },
    ],
    [
      "operator goal",
      (mission) => {
        if (mission.supervision) mission.supervision.operatorGoal = "Different operator goal."
      },
    ],
    [
      "goal interpretation",
      (mission) => {
        if (mission.goalBrief) mission.goalBrief.interpretation += " New interpretation."
      },
    ],
    [
      "goal assumptions",
      (mission) => {
        mission.goalBrief?.assumptions.push("Another assumption.")
      },
    ],
    [
      "success criteria",
      (mission) => {
        mission.goalBrief?.successCriteria.push("Another obligation.")
      },
    ],
    [
      "fixed verification",
      (mission) => {
        mission.verifyCommand = "different trusted check"
      },
    ],
    [
      "operator verification",
      (mission) => {
        if (mission.supervision) mission.supervision.operatorVerifyCommand = "different operator check"
      },
    ],
    [
      "Chief Director model",
      (mission) => {
        chief(mission).model = "different-model"
      },
    ],
    [
      "Chief Director vendor",
      (mission) => {
        chief(mission).agentType = "codex"
      },
    ],
    [
      "Technical Director identity",
      (mission) => {
        mission.technicalLeadId = "other-cto"
      },
    ],
    [
      "Actor role",
      (mission) => {
        chief(mission).role += " Changed responsibility."
      },
    ],
    [
      "Actor skills",
      (mission) => {
        chief(mission).skills.push("oma-architecture")
      },
    ],
    [
      "task assignment",
      (mission) => {
        task(mission).personaId = "cto"
      },
    ],
    [
      "task instructions",
      (mission) => {
        task(mission).instructions += " Add another dependency."
      },
    ],
    [
      "task acceptance",
      (mission) => {
        task(mission).acceptance.push("Another obligation.")
      },
    ],
    [
      "task order",
      (mission) => {
        mission.plan?.tasks.reverse()
      },
    ],
  ])("invalidates cached advice when %s changes", (_label, mutate) => {
    const mission = fixture()
    const before = technicalPlanKey(mission)
    mutate(mission)
    expect(technicalPlanKey(mission)).not.toBe(before)
  })

  it("normalizes unordered dependency and skill sets without mutating the mission", () => {
    const mission = fixture()
    chief(mission).skills = ["oma-qa", "oma-architecture"]
    task(mission).dependencies = ["second", "first"]
    const before = JSON.stringify(mission)
    const key = technicalPlanKey(mission)
    expect(JSON.stringify(mission)).toBe(before)
    chief(mission).skills.reverse()
    task(mission).dependencies.reverse()
    expect(technicalPlanKey(mission)).toBe(key)
  })

  it("supports upfront advice without a plan or goal brief and changes when the Chief Director creates the plan", () => {
    const mission = fixture()
    delete mission.goalBrief
    delete mission.supervision
    const withPlan = technicalPlanKey(mission)
    expect(withPlan).toMatch(/^[a-f0-9]{64}$/)
    delete mission.plan
    expect(technicalPlanKey(mission)).toMatch(/^[a-f0-9]{64}$/)
    expect(technicalPlanKey(mission)).not.toBe(withPlan)
  })
})

describe("Technical Director technical review instructions", () => {
  it("uses the stable stage marker and actual goal, plan, assignments and selected Chief Director model", () => {
    const mission = fixture()
    const prompt = technicalReviewPrompt(mission)
    expect(prompt.split("\n")[0]).toBe("Review the mission plan as the Chief Director's Technical Director.")
    expect(prompt).toContain(CTO_ROLE)
    const input = JSON.parse(prompt.split("Technical review input (JSON data):\n")[1] ?? "")
    expect(input.planKey).toBe(technicalPlanKey(mission))
    expect(input.goal).toBe(mission.goal)
    expect(input.goalBrief).toEqual(mission.goalBrief)
    expect(input.plan).toEqual(actorPlanData(mission.plan))
    expect(input.actors).toEqual(mission.personas.map(actorData))
    expect(input.verifyCommand).toBe(mission.verifyCommand)
    expect(input.technicalLeadId).toBe("cto")
    expect(input.availableSkills).toEqual(mission.availableSkills)
  })

  it("requires evidenced cost, reuse and dependency decisions while preserving the user's outcome", () => {
    const prompt = technicalReviewPrompt(fixture())
    expect(prompt).toContain("manifests, lockfiles, shared modules, native integrations and existing diffs")
    expect(prompt).toContain("implementation, maintenance, runtime and Actor-call costs together")
    expect(prompt).toContain("state unknown instead of inventing")
    expect(prompt).toContain("concrete smaller adequate alternative or required evidence")
    expect(prompt).toContain("Do not weaken requirements, tests or the operator's verification command")
    expect(prompt).toContain("selected Chief Director vendor and model are fixed")
    expect(prompt).toContain("without asking for microapprovals")
  })

  it("keeps the review read-only and requests the standard actionable Review JSON", () => {
    const prompt = technicalReviewPrompt(fixture())
    expect(prompt).toContain("Read-only stage")
    expect(prompt).toContain(
      "Do not run modifying commands, install packages, execute the plan, publish, push or merge",
    )
    expect(prompt).toContain('{"passed":true,"summary":')
    expect(prompt).toContain('"findings":[]')
    expect(prompt).toContain("passed:false and actionable findings")
    expect(prompt).toContain("A passing assessment has no unresolved findings")
    expect(prompt).toContain("operator retains ultimate operational responsibility")
  })

  it("advises before planning and leaves uncertain profit tradeoffs to the Chief Director without veto or approval pauses", () => {
    const mission = fixture()
    delete mission.plan
    const prompt = technicalReviewPrompt(mission)
    expect(prompt.split("\n")[0]).toBe("Review the mission plan as the Chief Director's Technical Director.")
    expect(prompt).toContain("The Chief Director has not created a plan yet")
    expect(prompt).toContain("advisory, not an execution veto")
    expect(prompt).toContain("higher cost improves profit or the goal outcome")
    expect(prompt).toContain("Do not discard an opportunity solely because of uncertainty")
    expect(prompt).toContain("concrete economical validation step or alternative")
    expect(prompt).toContain("Do not invent profits, prices or evidence")
    const input = JSON.parse(prompt.split("Technical review input (JSON data):\n")[1] ?? "")
    expect(input.plan).toBeUndefined()
    expect(input.planKey).toBe(technicalPlanKey(mission))
  })
})
