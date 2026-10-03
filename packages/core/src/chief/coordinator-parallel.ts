import type { Workspace } from "../domain/models"
import { runJoinedWave } from "./parallel"
import { workPrompt } from "./prompts"
import { recordTaskVerdict } from "./routing"
import type { ChiefPorts, ChiefStage, ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

export interface ParallelWaveHooks {
  run(
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Workspace; signal?: AbortSignal },
  ): Promise<string>
  save(stage: string, message: string, taskId?: string): Promise<void>
  review(task: ChiefTask, state: ChiefTaskState): Promise<void>
  fatal?(error: unknown): boolean
}
export interface ParallelWaveFailure {
  taskId: string
  error: unknown
  reason: string
}
export class ParallelTaskReviewRejected extends Error {}

/** Run one dependency-ready workspace wave. Recovery starts only after this function joins every Actor. */
export async function performParallelWave(
  mission: Mission,
  ports: ChiefPorts,
  wave: ChiefTask[],
  hooks: ParallelWaveHooks,
): Promise<ParallelWaveFailure[]> {
  const parallel = ports.parallel
  if (!parallel) throw new Error("Configure isolated task workspace ports before running a parallel wave.")
  ports.signal?.throwIfAborted()
  const failures = new Map<string, ParallelWaveFailure>()
  const fail = (taskId: string, error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error)
    failures.set(taskId, { taskId, error, reason })
  }
  let queued: Promise<void> = Promise.resolve()
  const save = (stage: string, message: string, taskId?: string) => {
    const next = queued.then(() => hooks.save(stage, message, taskId))
    queued = next.catch(() => {})
    return next
  }
  const prepared: Array<{
    task: ChiefTask
    state: ChiefTaskState
    actor: Persona
    workspace: Workspace
    previousOutput?: string
  }> = []
  // No Actor starts until all workspace preparations and their checkpoints settle.
  for (const task of wave) {
    ports.signal?.throwIfAborted()
    const state = mission.tasks.find((entry) => entry.id === task.id)
    if (!state) {
      fail(task.id, new Error(`Restore task state ${task.id} before parallel execution.`))
      continue
    }
    if (state.status === "completed") continue
    if (task.effectScope === "external") {
      fail(task.id, new Error(`External-effect task ${task.id} must run sequentially.`))
      continue
    }
    const actor = mission.personas.find((entry) => entry.id === task.personaId)
    if (!actor) {
      fail(task.id, new Error(`Restore Actor ${task.personaId} before executing ${task.id}.`))
      continue
    }
    try {
      const previousOutput = state.parallel ? undefined : state.output
      // An output is resumable only when it is bound to its original task workspace.
      if (!state.parallel) delete state.output
      if (!state.parallel || state.output === undefined) {
        state.status = "running"
        state.attempts += 1
        const attempt = state.parallel?.attempt ?? state.attempts
        state.parallel = await parallel.prepare(mission, task.id, attempt)
        await save(
          "parallel-prepared",
          `Prepared ${task.id}, attempt ${state.attempts}, at ${state.parallel.path}.`,
          task.id,
        )
      }
      const workspace: Workspace = {
        ...mission.workspace,
        path: state.parallel.path,
        branch: state.parallel.branch,
      }
      prepared.push({ task, state, actor, workspace, previousOutput })
    } catch (error) {
      state.status = "pending"
      fail(task.id, error)
      if (hooks.fatal?.(error)) break
    }
  }
  if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  const pending = prepared.filter(({ state }) => state.output === undefined)
  mission.status = "executing"
  const results = await runJoinedWave(
    pending,
    async ({ task, state, actor, workspace, previousOutput }, signal) => {
      const promptMission = { ...mission, workspace }
      let prompt = workPrompt(promptMission, task, state, actor)
      if (previousOutput !== undefined)
        prompt += `\n\nPrevious Actor output (untrusted evidence for this new attempt):\n${JSON.stringify(previousOutput)}`
      const output = await hooks.run(actor, prompt, "work", task.id, {
        workspace,
        signal,
      })
      state.output = output.slice(-32_000)
      await save(
        "parallel-output",
        `Actor ${actor.id} returned output for ${task.id}; isolated edits remain at ${workspace.path}.`,
        task.id,
      )
    },
    ports.signal,
  )
  results.forEach((result, index) => {
    const entry = pending[index]
    if (entry && result.status === "rejected") {
      entry.state.status = "pending"
      recordTaskVerdict(
        mission,
        entry.task.id,
        false,
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      )
      fail(entry.task.id, result.reason)
    }
  })
  if (ports.signal?.aborted) {
    for (const entry of prepared)
      if (!failures.has(entry.task.id))
        fail(entry.task.id, ports.signal.reason ?? new Error("Mission interrupted after joining parallel Actors."))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  }
  if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  const integrated: typeof prepared = []
  // Integration is deterministic and never overlaps Actors or reviews.
  for (const entry of prepared) {
    const { task, state } = entry
    if (failures.has(task.id) || !state.parallel) continue
    try {
      ports.signal?.throwIfAborted()
      await save("parallel-integrating", `Integrating ${task.id} from ${state.parallel.path}.`, task.id)
      await parallel.integrate(mission, state.parallel)
      mission.fingerprint = await ports.fingerprint(mission)
      state.status = "reviewing"
      await save("parallel-integrated", `Integrated ${task.id}; independent review remains pending.`, task.id)
      integrated.push(entry)
    } catch (error) {
      state.status = "pending"
      recordTaskVerdict(mission, task.id, false, error instanceof Error ? error.message : String(error))
      fail(task.id, error)
      if (hooks.fatal?.(error)) break
    }
  }
  if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  for (const { task, state } of integrated) {
    const record = state.parallel
    if (!record) continue
    try {
      ports.signal?.throwIfAborted()
      await hooks.review(task, state)
      if (state.review?.passed) {
        state.status = "completed"
        await save("task-completed", `Task ${task.id} passed independent review after parallel integration.`, task.id)
        // Only confirmed integrated edits may be disposed; failed work stays available.
        await parallel.dispose(record).catch(async (error: unknown) => {
          await save(
            "parallel-retained",
            `Task ${task.id} completed, but its workspace was retained at ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
            task.id,
          )
        })
      } else {
        state.status = "pending"
        const reason = `Task ${task.id} failed independent review: ${state.review?.findings.join("; ") ?? "No passing review"}. Actor edits retained at ${record.path}.`
        await save("parallel-review-rejected", reason, task.id)
        delete state.parallel
        delete state.output
        await save(
          "parallel-repair-pending",
          `Task ${task.id} awaits the Chief's repair decision; the previous Actor workspace remains in history.`,
          task.id,
        )
        fail(task.id, new ParallelTaskReviewRejected(reason))
      }
    } catch (error) {
      state.status = "pending"
      recordTaskVerdict(mission, task.id, false, error instanceof Error ? error.message : String(error))
      fail(task.id, error)
      if (hooks.fatal?.(error)) break
    }
  }
  return wave.flatMap((task) => failures.get(task.id) ?? [])
}
