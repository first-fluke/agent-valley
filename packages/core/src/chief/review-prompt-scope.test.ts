import { describe, expect, it } from "vitest"
import { fixture, plan } from "./goal-supervision.fixture"
import {
  EXHAUSTIVE_REVIEW_RULE,
  INTEGRATION_CHECK_RULE,
  REPAIR_REVIEW_RULE,
  reviewPrompt,
  waveRepairRule,
  waveReviewRule,
  workPrompt,
} from "./prompts"
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

describe("ownership inside a concurrent wave", () => {
  function waveFixture(withIntegration = true) {
    const { mission, task, state } = taskFixture()
    const peer = { ...structuredClone(task), id: "task-swift" }
    const integration = { ...structuredClone(task), id: "task-integration", dependencies: [task.id, peer.id] }
    mission.plan = { tasks: withIntegration ? [task, peer, integration] : [task, peer] }
    state.integrationCheck = { at: "2026-01-01T00:00:00.000Z", ok: false, output: "swift fixture ... FAILED" }
    return { mission, task, state, peer, integration }
  }

  it("holds a wave task responsible only for its own files and names the integrating task", () => {
    const { mission, task, state } = waveFixture()
    const prompt = reviewPrompt(mission, task, state)
    expect(prompt).toContain(INTEGRATION_CHECK_RULE)
    expect(prompt).toContain("Wave ownership: this task was delivered in one wave with task-swift")
    expect(prompt).toContain("the later task that integrates this wave (task-integration)")
    expect(workPrompt(mission, task, state, mission.personas[1] as never)).toContain(
      "Concurrent wave: task-swift run at the same time",
    )
  })

  it("assigns shared failures to one wave task when no later task integrates the wave", () => {
    const { mission, task } = waveFixture(false)
    expect(waveReviewRule(mission, task)).toContain(
      `is repaired by the first of ${[task.id, "task-swift"].sort().join(", ")} only`,
    )
    expect(waveRepairRule(mission, task)).toContain("for the Chief Director instead")
  })

  it("leaves a task that runs alone under the ordinary repair ownership rule", () => {
    const { mission, task, state } = taskFixture()
    state.integrationCheck = { at: "2026-01-01T00:00:00.000Z", ok: false, output: "FAILED" }
    expect(waveReviewRule(mission, task)).toBeUndefined()
    expect(waveRepairRule(mission, task)).toBeUndefined()
    expect(reviewPrompt(mission, task, state)).not.toContain("Wave ownership")
  })
})
