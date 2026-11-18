import { describe, expect, it } from "vitest"
import type { Review } from "./contracts"
import { fixture, plan } from "./goal-supervision.fixture"
import { reviewPrompt } from "./prompts"
import { settleRepairReview } from "./review-response"
import { parseReview } from "./schemas"

const rejected = (findings: string[], followUps?: string[]): Review => ({
  passed: false,
  summary: "Repair inspected.",
  findings,
  ...(followUps ? { followUps } : {}),
})
const previous = rejected(["Release the permit after cancel."])

describe("the repair-review boundary", () => {
  // Regression: reviewers added newly noticed concerns about untouched code in every repair round, and each
  // one cost another Actor run, integration check and review. One mission rejected six tasks 22 times.
  it("keeps labelled findings and records the others as follow-ups", () => {
    const review = settleRepairReview(
      rejected(
        [
          "UNRESOLVED: 'Release the permit after cancel.' src/permit.ts:40 still returns before release.",
          "tests/support/native.rs:68 waits on a child without a deadline.",
        ],
        ["Rename the helper."],
      ),
      previous,
    )
    expect(review.passed).toBe(false)
    expect(review.findings).toEqual([
      "UNRESOLVED: 'Release the permit after cancel.' src/permit.ts:40 still returns before release.",
    ])
    expect(review.followUps).toEqual([
      "Rename the helper.",
      "tests/support/native.rs:68 waits on a child without a deadline.",
    ])
    expect(review.summary).toContain("recorded 1 finding(s) outside the repair boundary")
    expect(() => parseReview(JSON.stringify(review))).not.toThrow()
  })

  it("demotes a CHANGED finding about a file the repair did not change and passes a review left without blockers", () => {
    const review = settleRepairReview(
      rejected([
        "CHANGED: crates/cli/tests/launch.rs:144 calls wait() without a watchdog.",
        "SEVERE is not a label here, so this stays a follow-up.",
      ]),
      previous,
      ["crates/daemon/src/permit.rs"],
    )
    expect(review).toMatchObject({ passed: true, findings: [] })
    expect(review.followUps).toHaveLength(2)
    expect(() => parseReview(JSON.stringify(review))).not.toThrow()
    const kept = settleRepairReview(
      rejected(["changed: permit.rs:12 drops the guard early.", "CHECK: clippy fails in permit.rs."]),
      previous,
      ["crates/daemon/src/permit.rs"],
    )
    expect(kept.passed).toBe(false)
    expect(kept.findings).toHaveLength(2)
    expect(kept.followUps).toBeUndefined()
  })

  it("leaves first reviews, passing reviews and rejections without any label untouched", () => {
    const unlabelled = rejected(["The permit is still retained."])
    expect(settleRepairReview(unlabelled, undefined)).toBe(unlabelled)
    expect(settleRepairReview(unlabelled, previous)).toBe(unlabelled)
    expect(settleRepairReview(unlabelled, { passed: true, summary: "Accepted.", findings: [] })).toBe(unlabelled)
    const passing: Review = { passed: true, summary: "Resolved.", findings: [], followUps: ["Rename the helper."] }
    expect(settleRepairReview(passing, previous)).toBe(passing)
  })

  it("asks task reviews, not the final review, for followUps", () => {
    const { mission } = fixture()
    const task = structuredClone(plan.tasks[0])
    if (!task) throw new Error("Expected a task")
    mission.plan = { tasks: [task] }
    mission.tasks = [{ id: task.id, reviewerId: "reviewer", status: "reviewing", attempts: 1, output: "Delivered." }]
    const taskReview = reviewPrompt(mission, task, mission.tasks[0])
    expect(taskReview).toContain("top-level keys: passed, summary, findings, followUps")
    expect(taskReview).toContain("followUps, not findings")
    expect(reviewPrompt(mission)).not.toContain("findings, followUps")
  })
})
