import { describe, expect, it, vi } from "vitest"
import {
  LANE_CHECK_ROUNDS,
  ParallelTaskReviewRejected,
  type ParallelWaveHooks,
  performParallelWave,
  waveFailureNeedsRecovery,
} from "./coordinator-parallel"
import { fixture } from "./goal-supervision.fixture"
import type { TaskWorktreeRecord } from "./parallel-workspace"
import type { ChiefPorts, ChiefTask, Mission } from "./types"

function record(mission: Mission, taskId: string, attempt = 1): TaskWorktreeRecord {
  return {
    version: 1,
    missionId: mission.id,
    taskId,
    attempt,
    sourceWorkspacePath: mission.workspace.path,
    path: `/private/actor-${taskId}`,
    branch: `av-task/${taskId}`,
    baselineHead: "a".repeat(40),
    baselineTree: "b".repeat(40),
  }
}

function setup(check: NonNullable<NonNullable<ChiefPorts["parallel"]>["check"]>) {
  const { mission, ports } = fixture()
  const wave: ChiefTask[] = ["a", "b"].map((id) => ({
    id,
    title: id,
    personaId: "worker",
    instructions: `Work ${id}`,
    acceptance: [`Verified ${id}`],
    dependencies: [],
  }))
  mission.plan = { tasks: wave }
  mission.tasks = wave.map((task) => ({ id: task.id, reviewerId: "reviewer", status: "pending", attempts: 0 }))
  const events: string[] = []
  ports.parallel = {
    prepare: vi.fn(async (_mission, taskId, attempt) => record(mission, taskId, attempt)),
    integrate: vi.fn(async (_mission, workspace) => {
      events.push(`integrate:${workspace.taskId}`)
    }),
    dispose: vi.fn(async () => {}),
    check,
  }
  const prompts: Record<string, string[]> = { a: [], b: [] }
  const hooks: ParallelWaveHooks = {
    run: vi.fn(async (_actor, prompt, _stage, taskId) => {
      const seen = prompts[taskId ?? ""]
      seen?.push(prompt)
      events.push(`run:${taskId}`)
      return `Output ${taskId} ${seen?.length}`
    }),
    save: vi.fn(async (stage, message, taskId) => {
      events.push(`save:${stage}:${taskId}`)
      mission.history.push({ at: "2026-10-03", stage, message, taskId })
    }),
    review: vi.fn(async (_task, state) => {
      state.review = { passed: true, summary: "Inspected real output", findings: [] }
    }),
  }
  return { mission, ports, wave, hooks, events, prompts }
}

describe("pre-delivery check in an Actor's workspace", () => {
  // Regression: a failure a twenty-second command finds (a file over the length limit) was first seen after
  // the whole wave had returned, the tree was integrated and a ten-minute check had run; three rounds of one
  // mission went to it.
  it("returns a failed check to the same Actor before integration and delivers its repaired output", async () => {
    const failed = new Set(["a"])
    const check = vi.fn(async (_mission: Mission, workspace: TaskWorktreeRecord) => {
      if (!failed.delete(workspace.taskId)) return { ok: true, output: "PASS" }
      return { ok: false, output: "FAIL: src/long.rs has 554 lines" }
    })
    const { mission, ports, wave, hooks, events, prompts } = setup(check)
    expect(await performParallelWave(mission, ports, wave, hooks)).toEqual([])
    expect(prompts.a).toHaveLength(2)
    expect(prompts.b).toHaveLength(1)
    expect(prompts.a?.[1]).toContain("FAIL: src/long.rs has 554 lines")
    expect(prompts.a?.[1]).toContain("Output a 1")
    expect(mission.tasks.map((task) => task.output)).toEqual(["Output a 2", "Output b 1"])
    expect(mission.tasks.every((task) => task.status === "completed" && task.attempts === 1)).toBe(true)
    expect(events.filter((event) => event === "save:lane-check:a")).toHaveLength(1)
    expect(events.indexOf("save:lane-check:a")).toBeLessThan(events.indexOf("integrate:a"))
    expect(check).toHaveBeenCalledTimes(3)
  })

  it("stops returning the work after the bounded rounds and lets the integration check judge it", async () => {
    const check = vi.fn(async () => ({ ok: false, output: "FAIL: still failing" }))
    const { mission, ports, wave, hooks, prompts } = setup(check)
    expect(await performParallelWave(mission, ports, wave.slice(0, 1), hooks)).toEqual([])
    expect(prompts.a).toHaveLength(1 + LANE_CHECK_ROUNDS)
    expect(check).toHaveBeenCalledTimes(LANE_CHECK_ROUNDS)
    expect(mission.tasks[0]?.output).toBe(`Output a ${1 + LANE_CHECK_ROUNDS}`)
  })

  it("delivers at once when no command is configured for this mission", async () => {
    const check = vi.fn(async () => undefined)
    const { mission, ports, wave, hooks, prompts } = setup(check)
    expect(await performParallelWave(mission, ports, wave, hooks)).toEqual([])
    expect(prompts.a).toHaveLength(1)
    expect(check).toHaveBeenCalledTimes(2)
  })
})

describe("routing a wave failure to repair or to Chief recovery", () => {
  // Regression: a rejection whose findings mentioned ENOSPC was classified as an environment failure and
  // spent a Chief recovery round instead of an ordinary repair.
  it("repairs a review rejection whatever its findings quote", () => {
    const reason = "Task a failed independent review: after an ENOSPC partial write the file is not found (401)."
    expect(
      waveFailureNeedsRecovery({ taskId: "a", phase: "review", reason, error: new ParallelTaskReviewRejected(reason) }),
    ).toBe(false)
  })

  it("still asks the Chief when a review produced no verdict or the environment failed", () => {
    expect(
      waveFailureNeedsRecovery({ taskId: "a", phase: "review", reason: "no verdict", error: new Error("no verdict") }),
    ).toBe(true)
    const missing = "spawn codex ENOENT"
    expect(waveFailureNeedsRecovery({ taskId: "a", phase: "work", reason: missing, error: new Error(missing) })).toBe(
      true,
    )
    const defect = "The Actor returned an empty handoff."
    expect(waveFailureNeedsRecovery({ taskId: "a", phase: "work", reason: defect, error: new Error(defect) })).toBe(
      false,
    )
  })
})
