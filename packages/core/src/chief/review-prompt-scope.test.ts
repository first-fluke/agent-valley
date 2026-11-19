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

  it("has one open wave task update an earlier task's test that the wave superseded", () => {
    // Regression: a contract task asserted a placeholder result, the first lane replaced the behaviour, and
    // every integration check of the wave failed on that test because its repair was deferred to the
    // integrating task while no lane could edit the file.
    const { mission, task, state, peer } = waveFixture()
    mission.tasks = [state, { id: peer.id, reviewerId: "reviewer", status: "reviewing", attempts: 1 }]
    const [first, second] = [task, peer].sort((a, b) => a.id.localeCompare(b.id))
    if (!first || !second) throw new Error("Expected two wave tasks")
    expect(waveReviewRule(mission, first)).toContain(`It is repaired now by ${first.id} only`)
    expect(waveReviewRule(mission, first)).toContain("make it a finding for this task")
    expect(waveReviewRule(mission, second)).toContain(`It is repaired now by ${first.id} only`)
    expect(waveReviewRule(mission, second)).toContain("do not make it a finding for this task")
    expect(waveRepairRule(mission, first)).toContain("update exactly that expectation in that test")
    // A wave task that already passed review cannot repair it: ownership moves to the next open task.
    const passed = mission.tasks.find((entry) => entry.id === first.id)
    if (!passed) throw new Error("Expected task state")
    passed.status = "completed"
    expect(waveReviewRule(mission, second)).toContain(`It is repaired now by ${second.id} only`)
    expect(waveReviewRule(mission, second)).toContain("make it a finding for this task")
  })

  it("assigns shared failures to one wave task when no later task integrates the wave", () => {
    const { mission, task } = waveFixture(false)
    expect(waveReviewRule(mission, task)).toContain(
      `is repaired by the first of ${[task.id, "task-swift"].sort().join(", ")} only`,
    )
    expect(waveRepairRule(mission, task)).toContain("for the Chief Director instead")
    expect(waveReviewRule(mission, task)).not.toContain("It is repaired now by")
  })

  it("leaves a task that runs alone under the ordinary repair ownership rule", () => {
    const { mission, task, state } = taskFixture()
    state.integrationCheck = { at: "2026-01-01T00:00:00.000Z", ok: false, output: "FAILED" }
    expect(waveReviewRule(mission, task)).toBeUndefined()
    expect(waveRepairRule(mission, task)).toBeUndefined()
    expect(reviewPrompt(mission, task, state)).not.toContain("Wave ownership")
  })
})
