import { describe, expect, it } from "vitest"
import { designReviewPrompt } from "./design-lead"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { marketingReviewPrompt } from "./marketing-lead"
import { reviewPrompt } from "./prompts"
import { finalCriteria, parseFinalReview, parseReview } from "./schemas"
import { technicalReviewPrompt } from "./technical-lead"
import type { Mission } from "./types"

function missionFixture() {
  const { mission } = fixture()
  mission.plan = structuredClone(plan)
  mission.goalBrief = structuredClone(brief)
  return mission
}

function examples(prompt: string) {
  const passing = prompt.match(/Passing response example:\n([^\n]+)/)?.[1]
  const rejected = prompt.match(/Rejected response example:\n([^\n]+)/)?.[1]
  expect(passing, "The model needs an example of the accepted response shape.").toBeDefined()
  expect(rejected, "An empty findings array does not establish its element type.").toBeDefined()
  return [passing ?? "", rejected ?? ""]
}

describe("Chief review response contract", () => {
  it.each([
    ["technical advice", technicalReviewPrompt],
    ["design advice", designReviewPrompt],
    ["marketing advice", marketingReviewPrompt],
    ["task and gate review", (mission: Mission) => reviewPrompt(mission, plan.tasks[0])],
    [
      "unsupervised final review",
      (mission: Mission) => {
        delete mission.supervision
        return reviewPrompt(mission)
      },
    ],
  ] as const)("gives %s a typed findings contract and parseable passing and rejected examples", (_stage, promptFor) => {
    const prompt = promptFor(missionFixture())
    expect(prompt).toContain("findings must be an array of nonempty strings")
    expect(prompt).toContain("Do not put objects, arrays, numbers or null in findings")
    expect(prompt).toContain("Do not add other top-level keys")
    const responses = examples(prompt).map(parseReview)
    expect(responses.map((response) => response.passed)).toEqual([true, false])
    expect(responses[0]?.findings).toEqual([])
    expect(responses[1]?.findings.length).toBeGreaterThan(0)
    for (const response of responses) {
      expect(Object.keys(response).sort()).toEqual(["findings", "passed", "summary"])
      expect(response.findings.every((finding) => typeof finding === "string" && finding.trim().length > 0)).toBe(true)
      expect(() => parseReview(JSON.stringify({ ...response, recommendation: "Unexpected extra key" }))).toThrow()
    }
  })

  it("keeps supervised final examples valid for every exact goal criterion", () => {
    const mission = missionFixture()
    const prompt = reviewPrompt(mission)
    expect(prompt).toContain("Do not add other top-level keys")
    expect(prompt).toContain("Each criteria entry has exactly criterion, passed and evidence")
    const responses = examples(prompt).map((source) => parseFinalReview(source, mission))
    expect(responses.map((response) => response.passed)).toEqual([true, false])
    for (const response of responses) {
      expect(response.criteria?.map(({ criterion }) => criterion)).toEqual(finalCriteria(mission))
      expect(Object.keys(response).sort()).toEqual(["criteria", "findings", "passed", "summary"])
    }
  })

  it("requires metric target criteria in final review even without supervision", () => {
    const mission = missionFixture()
    delete mission.supervision
    mission.operatingPolicy = {
      memory: true,
      reviewVendor: "prefer",
      metricTargets: [{ name: "activation", direction: "increase", target: 40 }],
    }
    const prompt = reviewPrompt(mission)
    expect(prompt).toContain("Assess every goal success criterion")
    const responses = examples(prompt)
    for (const source of responses) {
      expect(parseReview(source).criteria?.map(({ criterion }) => criterion)).toEqual(finalCriteria(mission))
    }
    expect(parseFinalReview(responses[1] ?? "", mission).passed).toBe(false)
  })

  it("continues rejecting the native object's concern/basis/recommendation shape without losing a string finding's evidence", () => {
    const finding = {
      concern: "Required repository inspection could not complete.",
      basis: "Read-only inspection failed before execution with sandbox_apply: Operation not permitted.",
      recommendation: "Inspect the trusted verifier and existing diffs once local read access works.",
    }
    const response = { passed: false, summary: "Repository evidence remains unverified.", findings: [finding] }
    expect(() => parseReview(JSON.stringify(response))).toThrow("expected string, received object")
    const evidence = Object.values(finding).join(" ")
    expect(parseReview(JSON.stringify({ ...response, findings: [evidence] })).findings).toEqual([evidence])
  })
})
