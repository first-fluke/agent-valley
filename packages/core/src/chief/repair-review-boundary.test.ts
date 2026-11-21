import { describe, expect, it } from "vitest"
import type { ChiefTaskState, Review } from "./contracts"
import { coordinate } from "./coordinator"
import { applyTaskReviewResult, applyWorkResult } from "./coordinator-results"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { REPAIR_REVIEW_RULE, reviewPrompt } from "./prompts"
import { settleRepairReview } from "./review-response"
import { missionSchema, parseReview } from "./schemas"

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

  it("preserves previousReview across applyWorkResult so repair prompts and settlement actually run", async () => {
    const { mission, ports } = fixture()
    mission.maxRepairs = 2
    mission.plan = structuredClone(plan)
    mission.goalBrief = structuredClone(brief)
    if (mission.supervision) mission.supervision.originalAcceptance = plan.tasks.flatMap((task) => task.acceptance)
    mission.status = "executing"
    mission.tasks = [{ id: "onboarding", reviewerId: "reviewer", status: "pending", attempts: 0 }]

    const reviewPrompts: string[] = []
    let taskReviews = 0
    const baseRun = ports.runAgent
    ports.runAgent = async (persona, prompt, currentMission, stage, context) => {
      if (stage === "review") {
        reviewPrompts.push(prompt)
        taskReviews += 1
        if (taskReviews === 1) {
          return JSON.stringify({
            passed: false,
            summary: "Missing empty-account handling.",
            findings: ["Handle the empty-account state in src/onboarding.ts."],
          })
        }
        // Second review (after applyWorkResult) emits an unlabelled finding plus an out-of-scope CHANGED finding
        // about an untouched file; settleRepairReview must demote both and accept the task.
        const state = currentMission.tasks[0]
        if (state) {
          state.changeSet = {
            version: 1,
            inputTree: "a".repeat(40),
            deliveryTree: "b".repeat(40),
            files: [{ path: "src/onboarding.ts", status: "modified", size: 120, sha256: "c".repeat(64) }],
            diff: "@@ -1 +1 @@\n+fixed\n",
            diffTruncated: false,
          }
        }
        return JSON.stringify({
          passed: false,
          summary: "Exotic edge case noticed outside repaired diff.",
          findings: [
            "CHANGED: src/unrelated.ts:12 fails under unset _ with nounset.",
            "Also check descriptor limit 10.",
          ],
        })
      }
      return baseRun(persona, prompt, currentMission, stage, context)
    }

    const done = await coordinate(mission, ports)
    expect(done.status).toBe("completed")
    expect(taskReviews).toBe(2)
    expect(reviewPrompts[0]).not.toContain(REPAIR_REVIEW_RULE)
    expect(reviewPrompts[0]).toContain("Concern: describe the gap.")
    expect(reviewPrompts[1]).toContain(REPAIR_REVIEW_RULE)
    expect(reviewPrompts[1]).toContain("UNRESOLVED: '<quote prior finding>'")
    const secondInput = JSON.parse(reviewPrompts[1]?.split("Review input (JSON data):\n")[1] ?? "")
    expect(secondInput.previousReview.findings).toEqual(["Handle the empty-account state in src/onboarding.ts."])
    expect(done.tasks[0]?.review?.passed).toBe(true)
    expect(done.tasks[0]?.review?.followUps).toHaveLength(2)
    expect(done.tasks[0]?.previousReview).toBeUndefined()
    expect(() => missionSchema.parse(done)).not.toThrow()
  })

  it("does not treat a completed task's passing review as a repair review and clears previousReview on new verdict", () => {
    const { mission } = fixture()
    const task = structuredClone(plan.tasks[0])
    if (!task) throw new Error("Expected a task")
    mission.plan = { tasks: [task] }
    const state: ChiefTaskState = {
      id: task.id,
      reviewerId: "reviewer",
      status: "pending",
      attempts: 1,
      review: previous,
    }
    mission.tasks = [state]
    applyWorkResult(task, state, "Repaired.")
    expect(state.review).toBeUndefined()
    expect(state.previousReview).toEqual(previous)
    expect(() => missionSchema.parse(mission)).not.toThrow()

    applyTaskReviewResult(mission, state, { passed: true, summary: "Resolved.", findings: [] })
    expect(state.previousReview).toBeUndefined()
    const gatePrompt = reviewPrompt(mission, task, state)
    expect(gatePrompt).not.toContain(REPAIR_REVIEW_RULE)
  })
})
