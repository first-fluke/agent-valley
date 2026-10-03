import { describe, expect, it } from "vitest"
import { actorData } from "./actor-contract"
import { CDO_ROLE, designPlanKey, designReviewPrompt } from "./design-lead"
import { CTO_ROLE, missionAdviceKey, technicalPlanKey } from "./technical-lead"
import type { Mission } from "./types"

function fixture(): Mission {
  return {
    id: "design-test",
    goal: "Improve first-use conversion while retaining returning users.",
    chiefId: "chief",
    technicalLeadId: "cto",
    designLeadId: "cdo",
    personas: [
      {
        id: "chief",
        name: "Chief Director",
        role: "Coordinate",
        agentType: "claude",
        model: "operator-model",
        skills: [],
      },
      { id: "cto", name: "Technical Director", role: CTO_ROLE, agentType: "codex", skills: [] },
      { id: "cdo", name: "Design Director", role: CDO_ROLE, agentType: "claude", skills: ["oma-design"] },
    ],
    workspace: {
      issueId: "design-test",
      path: "/target",
      key: "design-test",
      branch: "chief/design-test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    availableSkills: [
      {
        name: "oma-design",
        description: "Inspect product design.",
        path: "/target/.agents/skills/oma-design/SKILL.md",
      },
    ],
    verifyCommand: "bun run test:onboarding",
    timeoutSec: 300,
    maxRepairs: 2,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
}

describe("Design Director shared advisory identity", () => {
  it("uses the same canonical mission identity as technical advice before a plan exists", () => {
    const mission = fixture()
    expect(designPlanKey(mission)).toMatch(/^[a-f0-9]{64}$/)
    expect(designPlanKey(mission)).toBe(missionAdviceKey(mission))
    expect(designPlanKey(mission)).toBe(technicalPlanKey(mission))
    expect(designPlanKey(JSON.parse(JSON.stringify(mission)))).toBe(designPlanKey(mission))
  })

  it("changes when the Design Director assignment, role or initial Chief Director plan changes", () => {
    const original = fixture()
    const before = designPlanKey(original)
    const differentLead = structuredClone(original)
    differentLead.designLeadId = "another-cdo"
    expect(designPlanKey(differentLead)).not.toBe(before)
    const differentRole = structuredClone(original)
    const cdo = differentRole.personas.find((persona) => persona.id === differentRole.designLeadId)
    if (!cdo) throw new Error("Missing Design Director fixture.")
    cdo.role += " Changed design responsibility."
    expect(designPlanKey(differentRole)).not.toBe(before)
    original.plan = {
      tasks: [
        {
          id: "inspect",
          title: "Inspect onboarding",
          personaId: "cdo",
          instructions: "Inspect existing onboarding evidence.",
          acceptance: ["Evidence is recorded."],
          dependencies: [],
        },
      ],
    }
    expect(designPlanKey(original)).not.toBe(before)
  })

  it("does not key cached advice on its own review or mutable evidence bookkeeping", () => {
    const mission = fixture()
    const before = designPlanKey(mission)
    mission.designReview = {
      planKey: before,
      reviewerId: "cdo",
      fingerprint: "worktree-baseline",
      review: {
        passed: false,
        summary: "No measured conversion baseline is available.",
        findings: ["Record a baseline before claiming conversion improved."],
      },
    }
    mission.fingerprint = "another-evidence-version"
    mission.updatedAt = "2026-10-04"
    expect(designPlanKey(mission)).toBe(before)
  })
})

describe("Design Director data and design guidance", () => {
  it("preserves the requested female design soulmate and explicit dark-pattern retention preference", () => {
    expect(CDO_ROLE).toContain("permanent female Design Director and design soulmate")
    expect(CDO_ROLE).toContain(
      "She favors dark patterns to retain users and evaluates their effects with conversion, churn and usability data.",
    )
    expect(designReviewPrompt(fixture())).toContain(CDO_ROLE)
  })

  it("provides a stable stage marker and the actual planless goal, assignments, skill paths and Technical Director advice", () => {
    const mission = fixture()
    mission.technicalReview = {
      planKey: technicalPlanKey(mission),
      reviewerId: "cto",
      fingerprint: "baseline",
      review: { passed: true, summary: "Reuse existing instrumentation.", findings: [] },
    }
    const prompt = designReviewPrompt(mission)
    expect(prompt.split("\n")[0]).toBe("Review the mission goal as the Chief Director's Design Director.")
    expect(prompt).toContain("The Chief Director has not created a plan yet")
    const input = JSON.parse(prompt.split("Design review input (JSON data):\n")[1] ?? "")
    expect(input.planKey).toBe(designPlanKey(mission))
    expect(input.goal).toBe(mission.goal)
    expect(input.actors).toEqual(mission.personas.map(actorData))
    expect(input.designLeadId).toBe("cdo")
    expect(input.technicalAdvice).toEqual(mission.technicalReview)
    expect(input.availableSkills).toEqual(mission.availableSkills)
    expect(input.plan).toBeUndefined()
  })

  it("diverges and converges using user personas, shortest journeys and visible intuitive interactions", () => {
    const prompt = designReviewPrompt(fixture())
    expect(prompt).toContain("Diverge into a few distinct design alternatives, then converge")
    expect(prompt).toContain("end-user personas")
    expect(prompt).toContain("product users, not the mission's Actor roster")
    expect(prompt).toContain("shortest successful user journey")
    expect(prompt).toContain("intuitive controls")
    expect(prompt).toContain("visibility of current state")
    expect(prompt).toContain("Keep implementation details out of product user flows")
  })

  it("requires actual data and a minimal test proposal when analytics or field observations are missing", () => {
    const prompt = designReviewPrompt(fixture())
    expect(prompt).toContain("DATA is required for conclusions")
    expect(prompt).toContain("Distinguish real observations and measured analytics from simulations")
    expect(prompt).toContain("Never invent analytics, sample sizes, field-test participants, results or profits")
    expect(prompt).toContain("never describe a simulated walkthrough as an actual user or field test")
    expect(prompt).toContain("smallest useful instrumentation or user/field test")
    expect(prompt).toContain("observation or metric, comparison and decision rule")
    expect(prompt).toContain("do not execute them in this read-only stage")
    expect(prompt).toContain("do not discard an opportunity solely because evidence is not yet available")
  })

  it("compares retention opportunities using conversion, churn and usability outcomes as advisory input", () => {
    const prompt = designReviewPrompt(fixture())
    expect(prompt).toContain("Favor retention experiments, including dark patterns")
    expect(prompt).toContain("conversion, repeat use, churn, task success, time and usability observations")
    expect(prompt).toContain("longer-term churn and user outcomes")
    expect(prompt).toContain("Chief Director's profit and goal tradeoffs")
    expect(prompt).toContain("advisory, not an execution veto")
    expect(prompt).toContain("operator retains ultimate operational responsibility")
    expect(prompt).toContain("without asking for microapprovals")
  })

  it("keeps advisory output read-only and uses the standard Review JSON for actionable concerns", () => {
    const prompt = designReviewPrompt(fixture())
    expect(prompt).toContain("Read-only stage")
    expect(prompt).toContain(
      "Do not run modifying commands, install packages, execute experiments, publish, push or merge",
    )
    expect(prompt).toContain("fixed verification command")
    expect(prompt).toContain('{"passed":true,"summary":')
    expect(prompt).toContain('"findings":[]')
    expect(prompt).toContain("Use passed:false with actionable concerns")
    expect(prompt).toContain("the Chief Director decides how to act on them")
  })
})
