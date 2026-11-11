import { describe, expect, it } from "vitest"
import { fixture, plan } from "./goal-supervision.fixture"
import { EXHAUSTIVE_REVIEW_RULE, REPAIR_REVIEW_RULE, reviewPrompt } from "./prompts"
import type { ChiefTaskState } from "./types"

function taskFixture() {
  const { mission } = fixture()
  const task = structuredClone(plan.tasks[0])
  if (!task) throw new Error("Expected a task")
  mission.plan = { tasks: [task] }
  const state: ChiefTaskState = {
    id: task.id,
    reviewerId: "reviewer",
    status: "reviewing",
    attempts: 1,
    output: "Delivered docs/onboarding.md.",
  }
  mission.tasks = [state]
  return { mission, task, state }
}

describe("independent task review scope", () => {
  it("asks the first review for every blocking defect at once", () => {
    const { mission, task, state } = taskFixture()
    const prompt = reviewPrompt(mission, task, state)
    expect(prompt).toContain(EXHAUSTIVE_REVIEW_RULE)
    expect(prompt).not.toContain(REPAIR_REVIEW_RULE)
  })

  it("limits a repair review to the prior findings, the repaired code and severe defects", () => {
    const { mission, task, state } = taskFixture()
    state.attempts = 2
    state.review = { passed: false, summary: "Permit retained after cancel.", findings: ["Release the permit."] }
    const prompt = reviewPrompt(mission, task, state)
    expect(prompt).toContain(EXHAUSTIVE_REVIEW_RULE)
    expect(prompt).toContain(REPAIR_REVIEW_RULE)
    const input = JSON.parse(prompt.split("Review input (JSON data):\n")[1] ?? "")
    expect(input.previousReview.findings).toEqual(["Release the permit."])
  })

  it("keeps the final mission review on its own goal criteria", () => {
    const { mission } = taskFixture()
    expect(reviewPrompt(mission)).not.toContain(EXHAUSTIVE_REVIEW_RULE)
  })
})
