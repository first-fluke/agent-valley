import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { finalReviewRepairScope, resetTaskApprovals } from "./coordinator-state"
import { brief, fixture, passed } from "./goal-supervision.fixture"
import { fallbackReport } from "./reports"
import { finalCriteria, validateMission } from "./schemas"
import type { ChiefTask, ChiefTaskState, Mission, Review } from "./types"

function task(id: string, dependencies: string[] = []): ChiefTask {
  return { id, title: id, personaId: "worker", instructions: `Do ${id}`, acceptance: [`${id} done`], dependencies }
}

function passingFinal(mission: Mission): string {
  return JSON.stringify({
    passed: true,
    summary: "Approved",
    findings: [],
    criteria: finalCriteria(mission).map((criterion) => ({ criterion, passed: true, evidence: "inspected" })),
  })
}

function failingFinal(mission: Mission, findings: string[]): string {
  return JSON.stringify({
    passed: false,
    summary: "Findings remain",
    findings,
    criteria: finalCriteria(mission).map((criterion) => ({ criterion, passed: false, evidence: "missing" })),
  })
}

/** Run the fixture to completion on a chosen plan, then return a reloadable finished mission. */
async function completeMission(value: ReturnType<typeof fixture>, tasks: ChiefTask[]): Promise<Mission> {
  value.mission.maxRepairs = 3
  const original = value.runAgent.getMockImplementation()
  value.runAgent.mockImplementation(async (...args) => {
    if (args[3] === "plan") return JSON.stringify({ tasks, goalBrief: brief })
    return (await original?.(...args)) ?? ""
  })
  await coordinate(value.mission, value.ports)
  if (value.mission.status !== "completed") throw new Error("Expected the fixture mission to complete")
  return validateMission(structuredClone(value.mission))
}

/** Resume a finished mission where the first final review fails with `findings`, then passes. */
function failThenPassFinal(value: ReturnType<typeof fixture>, findings: string[]): void {
  const original = value.runAgent.getMockImplementation()
  let finalCalls = 0
  value.runAgent.mockImplementation(async (actor, prompt, mission, stage, context) => {
    if (stage === "work") return `Repaired ${context?.taskId}`
    if (stage === "review") return passed
    if (stage === "final-review") return ++finalCalls === 1 ? failingFinal(mission, findings) : passingFinal(mission)
    if (stage === "report") return JSON.stringify(fallbackReport(mission))
    return (await original?.(actor, prompt, mission, stage, context)) ?? passed
  })
  value.verify.mockImplementation(async () => ({ ok: true, output: "verified" }))
}

function completed(id: string, index: number): ChiefTaskState {
  return {
    id,
    reviewerId: "reviewer",
    status: "completed",
    attempts: 1,
    output: `output ${index}`,
    review: { passed: true, summary: "passed", findings: [] },
    fingerprint: `fingerprint-${index}`,
  }
}

describe("final-review repair scope derivation", () => {
  const mission = (tasks: ChiefTask[]): Mission => ({ ...fixture().mission, plan: { tasks } })
  const review = (findings: string[]): Review => ({ passed: false, summary: "findings", findings })

  it("includes a named task and its transitive dependents", () => {
    const tasks = [task("task-1"), task("task-2"), task("task-3", ["task-2"]), task("task-4", ["task-3"])]
    const scope = finalReviewRepairScope(mission(tasks), review(["task-2 is missing evidence files"]))
    expect([...(scope ?? [])].sort()).toEqual(["task-2", "task-3", "task-4"])
  })

  it("matches whole task ids only", () => {
    const tasks = [task("task-6"), task("task-60")]
    const scope = finalReviewRepairScope(mission(tasks), review(["task-6 is missing evidence"]))
    expect([...(scope ?? [])]).toEqual(["task-6"])
  })

  it("returns null when no task id is named", () => {
    const tasks = [task("task-1"), task("task-2")]
    expect(finalReviewRepairScope(mission(tasks), review(["The configured-target obligation remains"]))).toBeNull()
  })
})

describe("scoped task approval reset", () => {
  it("re-reviews delivered tasks without re-executing them when only approvals are stale", () => {
    const { mission } = fixture()
    mission.tasks = [completed("task-1", 1), completed("task-2", 2)]
    const outputs = mission.tasks.map((state) => state.output)
    resetTaskApprovals(mission, { preserveUnfinished: true, reviewOnly: true })
    expect(mission.tasks.map((state) => state.status)).toEqual(["reviewing", "reviewing"])
    expect(mission.tasks.map((state) => state.output)).toEqual(outputs)
    expect(mission.tasks.every((state) => state.review === undefined && state.fingerprint === undefined)).toBe(true)
  })

  it("resets only the named tasks and preserves approved tasks with a recorded fingerprint", () => {
    const { mission } = fixture()
    mission.plan = { tasks: [task("task-1"), task("task-2")] }
    mission.tasks = [completed("task-1", 1), completed("task-2", 2)]
    resetTaskApprovals(mission, { keepReviews: true, resetTaskIds: new Set(["task-2"]) })
    expect(mission.tasks[0]).toMatchObject({
      status: "completed",
      output: "output 1",
      fingerprint: "fingerprint-1",
      review: { passed: true },
    })
    expect(mission.tasks[1]).toMatchObject({ status: "pending" })
    expect(mission.tasks[1]?.output).toBeUndefined()
    expect(mission.tasks[1]?.fingerprint).toBeUndefined()
    expect(mission.history.some((event) => event.stage === "task-preserved" && event.taskId === "task-1")).toBe(true)
    expect(mission.history.some((event) => event.stage === "task-preserved" && event.taskId === "task-2")).toBe(false)
  })

  it("re-executes the selected target and re-reviews delivered siblings when no scope is supplied", () => {
    const { mission } = fixture()
    mission.plan = { tasks: [task("task-1"), task("task-2")] }
    mission.tasks = [completed("task-1", 1), completed("task-2", 2)]
    resetTaskApprovals(mission, { keepReviews: true })
    expect(mission.tasks[0]).toMatchObject({ status: "reviewing", output: "output 1" })
    expect(mission.tasks[0]?.review).toBeUndefined()
    expect(mission.tasks[0]?.fingerprint).toBeUndefined()
    expect(mission.tasks[1]).toMatchObject({ status: "pending" })
    expect(mission.tasks[1]?.output).toBeUndefined()
    expect(mission.history.some((event) => event.stage === "task-preserved")).toBe(false)
  })

  it("re-executes every explicitly scoped task even when it is not the selected target", () => {
    const { mission } = fixture()
    mission.plan = { tasks: [task("task-1"), task("task-2"), task("task-3")] }
    mission.tasks = [completed("task-1", 1), completed("task-2", 2), completed("task-3", 3)]
    resetTaskApprovals(mission, {
      keepReviews: true,
      resetTaskIds: new Set(["task-1", "task-2"]),
      targetTaskId: "task-2",
    })
    expect(mission.tasks[0]).toMatchObject({ status: "pending" })
    expect(mission.tasks[0]?.output).toBeUndefined()
    expect(mission.tasks[1]).toMatchObject({ status: "pending" })
    expect(mission.tasks[1]?.output).toBeUndefined()
    expect(mission.tasks[2]).toMatchObject({ status: "completed", output: "output 3", review: { passed: true } })
  })
})

describe("final-review repair through the coordinator", () => {
  it("re-runs only the named task and keeps every other approved task completed", async () => {
    const value = fixture()
    const tasks = Array.from({ length: 9 }, (_, index) => task(`task-${index + 1}`))
    const finished = await completeMission(value, tasks)
    value.snapshots.length = 0
    failThenPassFinal(value, ["task-6 is missing evidence files", "The configured-target obligation remains"])
    const result = await coordinate(finished, value.ports)

    expect(result.status).toBe("completed")
    const byId = new Map(result.tasks.map((state) => [state.id, state]))
    for (let index = 1; index <= 9; index += 1) {
      const state = byId.get(`task-${index}`)
      expect(state?.status).toBe("completed")
      expect(state?.review?.passed).toBe(true)
      expect(state?.output).toBeTruthy()
      expect(state?.fingerprint).toBeTruthy()
      if (index === 6) expect(state).toMatchObject({ attempts: 2, output: "Repaired task-6" })
      else {
        expect(state).toMatchObject({ attempts: 1 })
        expect(state?.output).toContain("Changed onboarding.ts")
      }
    }
    const preserved = result.history.filter((event) => event.stage === "task-preserved").map((event) => event.taskId)
    expect(preserved.sort()).toEqual(["task-1", "task-2", "task-3", "task-4", "task-5", "task-7", "task-8", "task-9"])
    expect(result.finalReview?.passed).toBe(true)
    expect(result.verification?.ok).toBe(true)
  })

  it("repairs the selected task, keeps the others and records why when the final review names no task", async () => {
    const value = fixture()
    const tasks = Array.from({ length: 3 }, (_, index) => task(`task-${index + 1}`))
    const finished = await completeMission(value, tasks)
    value.snapshots.length = 0
    failThenPassFinal(value, ["The configured-target obligation remains unresolved"])
    const result = await coordinate(finished, value.ports)

    expect(result.status).toBe("completed")
    const byId = new Map(result.tasks.map((state) => [state.id, state]))
    for (const id of ["task-1", "task-2"]) {
      expect(byId.get(id)).toMatchObject({ status: "completed", attempts: 1, review: { passed: true } })
      expect(byId.get(id)?.output).toContain("Changed onboarding.ts")
    }
    expect(byId.get("task-3")).toMatchObject({ status: "completed", attempts: 2, output: "Repaired task-3" })
    const preserved = result.history.filter((event) => event.stage === "task-preserved").map((event) => event.taskId)
    expect(preserved.sort()).toEqual(["task-1", "task-2"])
    expect(
      result.history.some(
        (event) =>
          event.stage === "repair-scope" &&
          event.taskId === "task-3" &&
          event.message.includes("named no specific task") &&
          event.message.includes("task-3"),
      ),
    ).toBe(true)
  })

  it("also resets the dependent tasks of a named task", async () => {
    const value = fixture()
    const tasks = [task("task-1"), task("task-2"), task("task-3", ["task-2"])]
    const finished = await completeMission(value, tasks)
    value.snapshots.length = 0
    failThenPassFinal(value, ["task-2 is missing evidence files"])
    const result = await coordinate(finished, value.ports)

    expect(result.status).toBe("completed")
    const byId = new Map(result.tasks.map((state) => [state.id, state]))
    expect(byId.get("task-1")).toMatchObject({ status: "completed", attempts: 1 })
    expect(byId.get("task-1")?.output).toContain("Changed onboarding.ts")
    expect(byId.get("task-2")).toMatchObject({ status: "completed", attempts: 2, output: "Repaired task-2" })
    expect(byId.get("task-3")).toMatchObject({ status: "completed", attempts: 2, output: "Repaired task-3" })
    expect(result.history.some((event) => event.stage === "task-preserved" && event.taskId === "task-1")).toBe(true)
  })
})
