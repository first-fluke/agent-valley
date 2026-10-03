import { describe, expect, it } from "vitest"
import { actorData, actorPlanData } from "./actor-contract"
import { CDO_ROLE, designPlanKey } from "./design-lead"
import { CMO_ROLE, marketingPlanKey, marketingReviewPrompt } from "./marketing-lead"
import { CTO_ROLE, missionAdviceKey, technicalPlanKey } from "./technical-lead"
import type { Mission } from "./types"

function fixture(): Mission {
  return {
    id: "marketing-test",
    goal: "Find the shortest evidenced route to revenue for the existing product.",
    chiefId: "chief",
    technicalLeadId: "cto",
    designLeadId: "cdo",
    marketingLeadId: "cmo",
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
      { id: "cdo", name: "Design Director", role: CDO_ROLE, agentType: "claude", skills: [] },
      { id: "cmo", name: "Marketing Director", role: CMO_ROLE, agentType: "codex", skills: ["oma-market"] },
    ],
    workspace: {
      issueId: "marketing-test",
      path: "/target",
      key: "marketing-test",
      branch: "chief/marketing-test",
      status: "idle",
      createdAt: "2026-10-03",
    },
    availableSkills: [
      {
        name: "oma-market",
        description: "Research product markets.",
        path: "/target/.agents/skills/oma-market/SKILL.md",
      },
    ],
    verifyCommand: "test -s growth-report.md",
    timeoutSec: 300,
    maxRepairs: 2,
    status: "pending",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    tasks: [],
    history: [],
  }
}

describe("Marketing Director shared advisory identity", () => {
  it("supports a planless goal with the common Technical Director/Design Director/Marketing Director input identity", () => {
    const mission = fixture()
    expect(marketingPlanKey(mission)).toMatch(/^[a-f0-9]{64}$/)
    expect(marketingPlanKey(mission)).toBe(missionAdviceKey(mission))
    expect(marketingPlanKey(mission)).toBe(technicalPlanKey(mission))
    expect(marketingPlanKey(mission)).toBe(designPlanKey(mission))
    expect(marketingPlanKey(JSON.parse(JSON.stringify(mission)))).toBe(marketingPlanKey(mission))
  })

  it("invalidates all upfront advice identities when the nominated Marketing Director changes", () => {
    const mission = fixture()
    const before = marketingPlanKey(mission)
    mission.marketingLeadId = "another-cmo"
    expect(marketingPlanKey(mission)).not.toBe(before)
    expect(technicalPlanKey(mission)).not.toBe(before)
    expect(designPlanKey(mission)).not.toBe(before)
  })

  it("changes when the goal, Marketing Director responsibilities or optional plan changes", () => {
    const original = fixture()
    const before = marketingPlanKey(original)
    const goalChange = structuredClone(original)
    goalChange.goal += " Also inspect a different audience."
    expect(marketingPlanKey(goalChange)).not.toBe(before)
    const roleChange = structuredClone(original)
    const cmo = roleChange.personas.find((persona) => persona.id === roleChange.marketingLeadId)
    if (!cmo) throw new Error("Missing Marketing Director fixture.")
    cmo.role += " Changed responsibility."
    expect(marketingPlanKey(roleChange)).not.toBe(before)
    original.plan = {
      tasks: [
        {
          id: "growth",
          title: "Write growth evidence",
          personaId: "cmo",
          instructions: "Compare observed revenue routes.",
          acceptance: ["Sources and hypotheses are separate."],
          dependencies: [],
        },
      ],
    }
    expect(marketingPlanKey(original)).not.toBe(before)
  })

  it("does not key advice on its cached review or mutable worktree bookkeeping", () => {
    const mission = fixture()
    const before = marketingPlanKey(mission)
    mission.marketingReview = {
      planKey: before,
      reviewerId: "cmo",
      fingerprint: "baseline",
      review: {
        passed: false,
        summary: "No attributable revenue data is available.",
        findings: ["Measure the baseline before claiming ROI improved."],
      },
    }
    mission.updatedAt = "2026-10-04"
    mission.fingerprint = "current-worktree"
    mission.history.push({ at: "2026-10-04", stage: "marketing-review", message: "Advisory recorded." })
    expect(marketingPlanKey(mission)).toBe(before)
  })
})

describe("Marketing Director promotion and revenue advice", () => {
  it("preserves the requested promotion, ROI, demanding-results and money-first Actor", () => {
    expect(CMO_ROLE).toContain("permanent Marketing Director")
    expect(CMO_ROLE).toContain("obsessed with product promotion and revenue")
    expect(CMO_ROLE).toContain("cannot sleep when ROI drops")
    expect(CMO_ROLE).toContain("demand measurable results and improvement from Actors and people")
    expect(CMO_ROLE).toContain("Money first: pursue profit by any effective means")
    expect(CMO_ROLE).toContain("unknown indirect routes and gray opportunities")
    expect(marketingReviewPrompt(fixture())).toContain(CMO_ROLE)
  })

  it("passes the actual goal, roster, skills and earlier Technical Director/Design Director advice before planning", () => {
    const mission = fixture()
    const review = { passed: true, summary: "Use the existing measured product assets.", findings: [] }
    mission.technicalReview = { planKey: technicalPlanKey(mission), reviewerId: "cto", fingerprint: "baseline", review }
    mission.designReview = { planKey: designPlanKey(mission), reviewerId: "cdo", fingerprint: "baseline", review }
    const prompt = marketingReviewPrompt(mission)
    expect(prompt.split("\n")[0]).toBe("Review the mission goal as the Chief Director's Marketing Director.")
    expect(prompt).toContain("The Chief Director has not created a plan yet")
    const input = JSON.parse(prompt.split("Marketing review input (JSON data):\n")[1] ?? "")
    expect(input.planKey).toBe(marketingPlanKey(mission))
    expect(input.goal).toBe(mission.goal)
    expect(input.actors).toEqual(mission.personas.map(actorData))
    expect(input.marketingLeadId).toBe("cmo")
    expect(input.availableSkills).toEqual(mission.availableSkills)
    expect(input.technicalAdvice).toEqual(mission.technicalReview)
    expect(input.designAdvice).toEqual(mission.designReview)
    expect(input.plan).toBeUndefined()
  })

  it("can advise on an existing plan without granting execution permission", () => {
    const mission = fixture()
    mission.plan = {
      tasks: [
        {
          id: "growth",
          title: "Write a sourced growth report",
          personaId: "cmo",
          instructions: "Compare revenue routes.",
          acceptance: ["The report distinguishes facts and tests."],
          dependencies: [],
        },
      ],
    }
    const prompt = marketingReviewPrompt(mission)
    expect(prompt).toContain("current plan's promotion, acquisition, distribution and monetization opportunities")
    const input = JSON.parse(prompt.split("Marketing review input (JSON data):\n")[1] ?? "")
    expect(input.plan).toEqual(actorPlanData(mission.plan))
    expect(prompt).toContain("Read-only stage")
  })

  it("explores audience and channel routes with shortest time-to-revenue and unit economics", () => {
    const prompt = marketingReviewPrompt(fixture())
    expect(prompt).toContain("audience evidence, value proposition")
    expect(prompt).toContain("known acquisition and distribution channels plus novel indirect routes")
    expect(prompt).toContain("gray opportunities that fit this product and the operator goal")
    expect(prompt).toContain("shortest time-to-revenue")
    expect(prompt).toContain("customer acquisition cost (CAC), lifetime value (LTV), payback period and unit economics")
    expect(prompt).toContain("Do not invent sources, access, contacts, channel capabilities or actual traction")
  })

  it("requires observable tests and distinguishes actual results from unknown costs and attribution", () => {
    const prompt = marketingReviewPrompt(fixture())
    expect(prompt).toContain("Separate observed revenue, costs and attribution from estimates")
    expect(prompt).toContain(
      "never fabricate prices, ad costs, actual revenue, analytics, attribution or profit forecasts",
    )
    expect(prompt).toContain("audience, hypothesis, channel, observable conversion or revenue metric")
    expect(prompt).toContain("comparison and decision rule")
    expect(prompt).toContain("do not pretend a proposed or simulated test was actually run")
    expect(prompt).toContain("propose minimal measurement before claiming ROI improved")
    expect(prompt).toContain("instead of equating activity or clicks with money")
    expect(prompt).toContain("Do not discard a promising route solely because it is uncertain")
  })

  it("keeps outreach, publication and spending out of this advisory phase and preserves Chief Director judgment", () => {
    const prompt = marketingReviewPrompt(fixture())
    expect(prompt).toContain(
      "Do not execute growth tests, contact people, send outreach, publish, push, merge, buy ads, spend money",
    )
    expect(prompt).toContain("advisory, not an execution veto or operator approval gate")
    expect(prompt).toContain("Chief Director owns the final business and execution judgment")
    expect(prompt).toContain("operator retains ultimate operational responsibility")
    expect(prompt).toContain("without asking for microapprovals")
    expect(prompt).toContain("does not grant outreach, publication or spending permission")
    expect(prompt).toContain('{"passed":true,"summary":')
    expect(prompt).toContain("Use passed:false with actionable concerns")
    expect(prompt).toContain("the Chief Director decides how to act on them")
  })
})
