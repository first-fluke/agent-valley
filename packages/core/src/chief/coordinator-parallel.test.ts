import { describe, expect, it, vi } from "vitest"
import { ParallelTaskReviewRejected, type ParallelWaveHooks, performParallelWave } from "./coordinator-parallel"
import { fixture } from "./goal-supervision.fixture"
import type { TaskWorktreeRecord } from "./parallel-workspace"
import { type ChiefPorts, type ChiefTask, executionPolicySchema, type Mission } from "./types"

function barrier() {
  let release: () => void = () => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
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
function setup() {
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
  const snapshots: Mission[] = []
  const parallel: NonNullable<ChiefPorts["parallel"]> = {
    prepare: vi.fn(async (_mission, taskId, attempt) => {
      events.push(`prepare:${taskId}`)
      return record(mission, taskId, attempt)
    }),
    integrate: vi.fn(async (_mission, workspace) => {
      events.push(`integrate:${workspace.taskId}`)
    }),
    dispose: vi.fn(async (workspace) => {
      events.push(`dispose:${workspace.taskId}`)
    }),
  }
  ports.parallel = parallel
  const hooks: ParallelWaveHooks = {
    run: vi.fn(async (_actor, _prompt, _stage, taskId) => {
      events.push(`run:${taskId}`)
      return `Output ${taskId}`
    }),
    save: vi.fn(async (stage, message, taskId) => {
      events.push(`save:${stage}:${taskId}`)
      mission.history.push({ at: "2026-10-03", stage, message, taskId })
      snapshots.push(structuredClone(mission))
    }),
    review: vi.fn(async (task, state) => {
      events.push(`review:${task.id}`)
      state.review = { passed: true, summary: "Inspected real output", findings: [] }
    }),
  }
  return { mission, ports, wave, parallel, hooks, events, snapshots }
}

describe("parallel Chief task coordination", () => {
  it("starts work concurrently after all preparations, checkpoints both outputs before plan-order integration, then reviews", async () => {
    const { mission, ports, wave, parallel, hooks, events, snapshots } = setup()
    const started = barrier()
    const finish = barrier()
    let count = 0
    hooks.run = vi.fn(async (_actor, prompt, _stage, taskId, context) => {
      expect(events.filter((event) => event.startsWith("prepare:"))).toEqual(["prepare:a", "prepare:b"])
      expect(context?.workspace?.path).toBe(`/private/actor-${taskId}`)
      expect(prompt).toContain(`/private/actor-${taskId}`)
      events.push(`run:${taskId}`)
      if (++count === 2) started.release()
      await finish.wait
      return `Output ${taskId}`
    })
    const work = performParallelWave(mission, ports, wave, hooks)
    await started.wait
    expect(parallel.integrate).not.toHaveBeenCalled()
    finish.release()
    expect(await work).toEqual([])
    expect(events.filter((event) => /^(integrate|review):/.test(event))).toEqual([
      "integrate:a",
      "integrate:b",
      "review:a",
      "review:b",
    ])
    const firstIntegration = events.indexOf("integrate:a")
    expect(events.indexOf("save:parallel-output:a")).toBeLessThan(firstIntegration)
    expect(events.indexOf("save:parallel-output:b")).toBeLessThan(firstIntegration)
    expect(snapshots.some((snapshot) => snapshot.tasks.every((state) => state.output?.startsWith("Output")))).toBe(true)
    expect(mission.tasks.every((state) => state.status === "completed" && state.attempts === 1)).toBe(true)
  })

  it("resumes checkpointed output without running or preparing either Actor again", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    for (const state of mission.tasks) {
      state.status = "running"
      state.attempts = 4
      state.parallel = record(mission, state.id, 4)
      state.output = `Saved output ${state.id}`
    }
    expect(await performParallelWave(mission, ports, wave, hooks)).toEqual([])
    expect(hooks.run).not.toHaveBeenCalled()
    expect(parallel.prepare).not.toHaveBeenCalled()
    expect(parallel.integrate).toHaveBeenCalledTimes(2)
    expect(mission.tasks.every((state) => state.attempts === 4 && state.output?.startsWith("Saved"))).toBe(true)
  })

  it("runs a new repaired Actor when previous output has no workspace binding, and never checkpoints it as a fresh delivery", async () => {
    const { mission, ports, wave, hooks, snapshots } = setup()
    const first = mission.tasks[0]
    if (!first) throw new Error("Missing fixture task")
    first.output = "Prior rejected Actor output"
    first.attempts = 2
    hooks.run = vi.fn(async (_actor, prompt, _stage, taskId) => {
      if (taskId === "a") expect(prompt).toContain("Prior rejected Actor output")
      return `New output ${taskId}`
    })
    expect(await performParallelWave(mission, ports, wave, hooks)).toEqual([])
    expect(hooks.run).toHaveBeenCalledTimes(2)
    expect(first).toMatchObject({ attempts: 3, output: "New output a", status: "completed" })
    const prepared = snapshots.find((snapshot) => snapshot.tasks[0]?.parallel)
    expect(prepared?.tasks[0]?.output).toBeUndefined()
  })

  it("joins running children before integrating success and reporting failed work", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    const started = barrier()
    const finish = barrier()
    hooks.run = vi.fn(async (_actor, _prompt, _stage, taskId) => {
      if (taskId === "a") throw new Error("Actual Actor failure")
      started.release()
      await finish.wait
      return "Successful B"
    })
    const running = performParallelWave(mission, ports, wave, hooks)
    await started.wait
    expect(parallel.integrate).not.toHaveBeenCalled()
    finish.release()
    const failures = await running
    expect(failures.map((failure) => failure.taskId)).toEqual(["a"])
    expect(failures[0]?.reason).toContain("Actual Actor failure")
    expect(mission.tasks[0]?.parallel).toBeDefined()
    expect(mission.tasks[0]?.status).toBe("pending")
    expect(mission.tasks[1]?.status).toBe("completed")
    expect(parallel.dispose).toHaveBeenCalledTimes(1)
  })

  it("records a dispose failure for rejected work without failing the wave", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    hooks.review = vi.fn(async (task, state) => {
      state.review =
        task.id === "a"
          ? { passed: false, summary: "Incomplete", findings: ["Missing evidence"] }
          : { passed: true, summary: "Passed", findings: [] }
    })
    parallel.dispose = vi.fn(async () => {
      throw new Error("disk busy")
    })
    const failures = await performParallelWave(mission, ports, wave, hooks)
    expect(failures.map((failure) => failure.taskId)).toEqual(["a"])
    expect(failures[0]?.error).toBeInstanceOf(ParallelTaskReviewRejected)
    expect(
      mission.history.filter((event) => event.stage === "parallel-retained" && event.message.includes("disk busy")),
    ).toHaveLength(2)
  })

  it("integrates rejected edits, clears retry output, disposes the Actor repository, and lets root consume the repair budget once", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    const first = mission.tasks[0]
    if (!first) throw new Error("Missing fixture task")
    first.repairRound = 1
    parallel.integrate = vi.fn(async (_mission, workspace) => {
      const state = mission.tasks.find((entry) => entry.id === workspace.taskId)
      if (state)
        state.changeSet = {
          version: 1,
          inputTree: "b".repeat(40),
          deliveryTree: "c".repeat(40),
          files: [{ path: "contract.json", status: "added", size: 3, sha256: "d".repeat(64) }],
          diff: "",
          diffTruncated: false,
        }
    })
    hooks.review = vi.fn(async (task, state) => {
      state.review =
        task.id === "a"
          ? { passed: false, summary: "Incomplete", findings: ["Missing actual acceptance evidence"] }
          : { passed: true, summary: "Passed", findings: [] }
    })
    const failures = await performParallelWave(mission, ports, wave, hooks)
    expect(failures[0]?.error).toBeInstanceOf(ParallelTaskReviewRejected)
    expect(first).toMatchObject({ status: "pending", repairRound: 1 })
    expect(first.parallel).toBeUndefined()
    expect(first.output).toBeUndefined()
    // A later direct repair in the mission worktree must not be reviewed against this stale delivery.
    expect(first.changeSet).toBeUndefined()
    expect(mission.tasks[1]?.changeSet).toBeDefined()
    expect(
      mission.history.some(
        (event) => event.stage === "parallel-review-rejected" && event.message.includes("/private/actor-a"),
      ),
    ).toBe(true)
    // Rejected edits are already integrated and kept as patch + evidence refs; the clone is redundant.
    expect(parallel.dispose).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(parallel.dispose)
        .mock.calls.map(([workspace]) => workspace.taskId)
        .sort(),
    ).toEqual(["a", "b"])
  })

  it("joins abort cleanup without integrating, reviewing, or discarding child workspaces", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    const controller = new AbortController()
    ports.signal = controller.signal
    const started = barrier()
    const cleanup = barrier()
    let count = 0
    let settled = false
    hooks.run = vi.fn(async (_actor, _prompt, _stage, _taskId, context) => {
      const signal = context?.signal
      if (!signal) throw new Error("No per-Actor signal")
      if (++count === 2) started.release()
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
      await cleanup.wait
      signal.throwIfAborted()
      return "Unreachable"
    })
    const running = performParallelWave(mission, ports, wave, hooks).then((result) => {
      settled = true
      return result
    })
    await started.wait
    controller.abort(new Error("Operator abort"))
    await Promise.resolve()
    expect(settled).toBe(false)
    cleanup.release()
    expect((await running).map((failure) => failure.taskId)).toEqual(["a", "b"])
    expect(parallel.integrate).not.toHaveBeenCalled()
    expect(parallel.dispose).not.toHaveBeenCalled()
    expect(hooks.review).not.toHaveBeenCalled()
    expect(mission.tasks.every((state) => state.parallel !== undefined)).toBe(true)
  })

  it("does not launch Actors when preparation checkpoint fails fatally", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    const checkpoint = new Error("Checkpoint failed")
    hooks.save = async () => {
      throw checkpoint
    }
    hooks.fatal = (error) => error === checkpoint
    expect((await performParallelWave(mission, ports, wave, hooks))[0]?.error).toBe(checkpoint)
    expect(hooks.run).not.toHaveBeenCalled()
    expect(parallel.integrate).not.toHaveBeenCalled()
  })

  it("does not run more reviewers after a fatal read-only violation", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    const violation = new Error("Review changed the product")
    hooks.review = vi.fn(async () => {
      throw violation
    })
    hooks.fatal = (error) => error === violation
    expect((await performParallelWave(mission, ports, wave, hooks))[0]?.error).toBe(violation)
    expect(hooks.review).toHaveBeenCalledTimes(1)
    expect(parallel.dispose).not.toHaveBeenCalled()
  })

  it("leaves external-effect tasks for sequential execution", async () => {
    const { mission, ports, wave, parallel, hooks } = setup()
    wave.forEach((task) => {
      task.effectScope = "external"
    })
    expect((await performParallelWave(mission, ports, wave, hooks)).map((failure) => failure.taskId)).toEqual([
      "a",
      "b",
    ])
    expect(parallel.prepare).not.toHaveBeenCalled()
    expect(hooks.run).not.toHaveBeenCalled()
  })

  it("overlaps independent reviews up to maxParallel only after every integration finished", async () => {
    const { mission, ports, wave, hooks, events } = setup()
    wave.push({
      id: "c",
      title: "c",
      personaId: "worker",
      instructions: "Work c",
      acceptance: ["Verified c"],
      dependencies: [],
    })
    mission.tasks.push({ id: "c", reviewerId: "reviewer", status: "pending", attempts: 0 })
    mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    const started = barrier()
    const finish = barrier()
    const reviewed: string[] = []
    let active = 0
    let maxActive = 0
    hooks.review = vi.fn(async (task, state) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      reviewed.push(task.id)
      events.push(`review:${task.id}`)
      if (reviewed.length === 2) started.release()
      await finish.wait
      active -= 1
      state.review = { passed: true, summary: "Inspected real output", findings: [] }
    })
    const running = performParallelWave(mission, ports, wave, hooks)
    await started.wait
    expect(maxActive).toBe(2)
    expect(reviewed).toHaveLength(2)
    const firstReview = events.findIndex((event) => event.startsWith("review:"))
    const lastIntegration = events.reduce((last, event, index) => (event.startsWith("integrate:") ? index : last), -1)
    expect(lastIntegration).toBeLessThan(firstReview)
    finish.release()
    expect(await running).toEqual([])
    expect(reviewed).toHaveLength(3)
    expect(maxActive).toBe(2)
    expect(mission.tasks.every((state) => state.status === "completed")).toBe(true)
  })

  it("serializes mission-state checkpoints while the review Actor calls overlap", async () => {
    const { mission, ports, wave, hooks } = setup()
    mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    const bothReviewing = barrier()
    const finish = barrier()
    let reviewCount = 0
    let reviewActive = 0
    let maxReviewActive = 0
    let saving = 0
    let maxSaving = 0
    hooks.review = vi.fn(async (_task, state) => {
      reviewActive += 1
      maxReviewActive = Math.max(maxReviewActive, reviewActive)
      if (++reviewCount === 2) bothReviewing.release()
      await finish.wait
      reviewActive -= 1
      state.review = { passed: true, summary: "Inspected real output", findings: [] }
    })
    const checkpoint = hooks.save
    hooks.save = vi.fn(async (stage, message, taskId) => {
      saving += 1
      maxSaving = Math.max(maxSaving, saving)
      await Promise.resolve()
      await Promise.resolve()
      await checkpoint(stage, message, taskId)
      saving -= 1
    })
    const running = performParallelWave(mission, ports, wave, hooks)
    await bothReviewing.wait
    finish.release()
    expect(await running).toEqual([])
    expect(maxReviewActive).toBe(2)
    expect(maxSaving).toBe(1)
  })

  it("stops starting reviews after a fatal review failure and joins the in-flight review", async () => {
    const { mission, ports, wave, hooks } = setup()
    wave.push({
      id: "c",
      title: "c",
      personaId: "worker",
      instructions: "Work c",
      acceptance: ["Verified c"],
      dependencies: [],
    })
    mission.tasks.push({ id: "c", reviewerId: "reviewer", status: "pending", attempts: 0 })
    mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 2 })
    const violation = new Error("Review changed the product")
    const bStarted = barrier()
    const fatalSeen = barrier()
    const finish = barrier()
    const reviewed: string[] = []
    hooks.review = vi.fn(async (task, state) => {
      reviewed.push(task.id)
      if (task.id === "a") {
        await bStarted.wait
        throw violation
      }
      if (task.id === "b") {
        bStarted.release()
        await finish.wait
      }
      state.review = { passed: true, summary: "Passed", findings: [] }
    })
    hooks.fatal = (error) => {
      if (error === violation) fatalSeen.release()
      return error === violation
    }
    const running = performParallelWave(mission, ports, wave, hooks)
    await bStarted.wait
    await fatalSeen.wait
    finish.release()
    const failures = await running
    expect(reviewed).toEqual(["a", "b"])
    expect(failures.find((failure) => failure.taskId === "a")?.error).toBe(violation)
    expect(mission.tasks.find((state) => state.id === "c")?.status).toBe("reviewing")
  })

  it("reviews sequentially in plan order when maxParallel is 1", async () => {
    const { mission, ports, wave, hooks, events } = setup()
    mission.executionPolicy = executionPolicySchema.parse({ maxParallel: 1 })
    const order: string[] = []
    let active = 0
    let maxActive = 0
    hooks.review = vi.fn(async (task, state) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push(task.id)
      events.push(`review:${task.id}`)
      await Promise.resolve()
      active -= 1
      state.review = { passed: true, summary: "Inspected real output", findings: [] }
    })
    expect(await performParallelWave(mission, ports, wave, hooks)).toEqual([])
    expect(order).toEqual(["a", "b"])
    expect(maxActive).toBe(1)
    expect(events.filter((event) => /^(integrate|review):/.test(event))).toEqual([
      "integrate:a",
      "integrate:b",
      "review:a",
      "review:b",
    ])
  })
})
