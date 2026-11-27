import type { Workspace } from "../domain/models"
import { recordIntegrationCheck } from "./coordinator-integration"
import { applyWorkResult, recordTaskReviewFailure } from "./coordinator-results"
import { classifyFailure, MissionPause } from "./execution"
import { runJoinedWave } from "./parallel"
import { type ParallelBaseline, ParallelIntegrationConflict } from "./parallel-workspace"
import { workPrompt } from "./prompts"
import { closeContinuedWorkRun } from "./routing"
import type { ChiefPorts, ChiefStage, ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

export interface ParallelWaveHooks {
  run(
    actor: Persona,
    prompt: string,
    stage: ChiefStage,
    taskId?: string,
    context?: { workspace?: Workspace; signal?: AbortSignal; parallelSlots?: number },
  ): Promise<string>
  save(stage: string, message: string, taskId?: string): Promise<void>
  review(task: ChiefTask, state: ChiefTaskState): Promise<void>
  fatal?(error: unknown): boolean
  /** Shared mission-state mutex; review Actor calls overlap, but checkpoints and outcomes stay serialized. */
  serialize?<T>(fn: () => Promise<T> | T): Promise<T>
  /**
   * Called once the wave's outputs are integrated and before its integrated check and reviews. True means the
   * caller already sent tasks to repair for what the outputs report, so the check and the reviews are skipped.
   */
  returned?(tasks: ChiefTask[]): Promise<boolean>
}
export interface ParallelWaveFailure {
  taskId: string
  error: unknown
  reason: string
  phase?: "work" | "integration" | "review"
}
export class ParallelTaskReviewRejected extends Error {}

/**
 * Whether a wave failure needs a Chief recovery decision instead of an ordinary repair. A review rejection
 * never does: its text is the reviewer's findings, which quote error names from the code under review
 * (ENOSPC, "not found", 401), and classifying that text once sent a rejected task to Chief recovery as an
 * environment failure.
 */
export function waveFailureNeedsRecovery(failure: ParallelWaveFailure): boolean {
  if (failure.error instanceof ParallelTaskReviewRejected) return false
  return (
    failure.phase === "review" ||
    failure.error instanceof ParallelIntegrationConflict ||
    ["environment", "authentication", "provider", "rate-limit"].includes(classifyFailure(failure.reason))
  )
}

/** A failed pre-delivery check goes back to its Actor at most this often; the integration check still follows. */
export const LANE_CHECK_ROUNDS = 2

/**
 * Runs the operator's quick pre-delivery command where an Actor just worked and, while it fails, returns the
 * output to that Actor in the same workspace. The same loop serves a wave's isolated workspaces and a task
 * that works alone in the mission workspace: a contract task once spent two full rounds on a file over the
 * length limit because only wave tasks were checked before delivery.
 */
export async function settlePreDeliveryCheck(options: {
  check: NonNullable<ChiefPorts["preDeliveryCheck"]> | undefined
  mission: Mission
  workspacePath: string
  taskId: string
  output: string
  rerun: (feedback: string) => Promise<string>
  save: (stage: string, message: string, taskId?: string) => Promise<void>
  signal?: AbortSignal
}): Promise<string> {
  const { check, mission, workspacePath, taskId, rerun, save, signal } = options
  let output = options.output
  for (let round = 1; check && round <= LANE_CHECK_ROUNDS; round += 1) {
    const checked = await check(mission, workspacePath, signal)
    if (!checked || checked.ok) break
    await save(
      "lane-check",
      `Pre-delivery check failed in the workspace of ${taskId} (${round}/${LANE_CHECK_ROUNDS}); its Actor continues there with the output. ${checked.output.slice(0, 1_200)}`,
      taskId,
    )
    // The returned run is closed by the check; otherwise it reads as an unreviewed routing probe and its
    // own continuation is refused, which once cost a Chief recovery round and a restart from scratch.
    closeContinuedWorkRun(mission, taskId)
    output = await rerun(laneCheckFeedback(output, checked.output))
  }
  return output
}

function laneCheckFeedback(previousOutput: string, checkOutput: string): string {
  return [
    "You already worked on this assignment in this workspace and your edits are still in it. After you returned, Agent Valley ran the operator's pre-delivery check here and it failed. Repair what the check reports in this same workspace, keep the work you already did, and return your complete handoff again.",
    `Pre-delivery check result:\n${checkOutput}`,
    `Your previous handoff (untrusted evidence):\n${JSON.stringify(previousOutput.slice(0, 6_000))}`,
  ].join("\n\n")
}

/**
 * Reclaim disposable Actor workspaces whose deliveries are already applied and checkpointed.
 * Cleanup failures are non-fatal so mid-mission waves proceed and `releaseStorage` retries at completion.
 */
export async function reclaimAppliedParallelWorkspaces(
  mission: Mission,
  parallel: NonNullable<ChiefPorts["parallel"]>,
  save: (stage: string, message: string, taskId?: string) => Promise<void>,
  taskId?: string,
): Promise<void> {
  if (!parallel.reclaimApplied) return
  try {
    const result = await parallel.reclaimApplied(mission)
    for (const issue of result.errors ?? []) {
      await save(
        "parallel-retained",
        `Applied Actor workspace was retained at ${issue.path}: ${issue.message}`,
        taskId,
      ).catch(() => {})
    }
  } catch (error) {
    await save(
      "parallel-retained",
      `Applied Actor workspaces were retained after wave integration: ${error instanceof Error ? error.message : String(error)}`,
      taskId,
    ).catch(() => {})
  }
}

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
  const fail = (taskId: string, error: unknown, phase: ParallelWaveFailure["phase"] = "work") => {
    const reason = error instanceof Error ? error.message : String(error)
    failures.set(taskId, { taskId, error, reason, phase })
  }
  let queued: Promise<unknown> = Promise.resolve()
  const localSerialize = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = queued.then(fn)
    queued = next.catch(() => {})
    return next
  }
  const serialize = hooks.serialize ?? localSerialize
  const rawSave = (stage: string, message: string, taskId?: string) => hooks.save(stage, message, taskId)
  const save = (stage: string, message: string, taskId?: string) => serialize(() => rawSave(stage, message, taskId))
  const prepared: Array<{
    task: ChiefTask
    state: ChiefTaskState
    actor: Persona
    workspace: Workspace
    previousOutput?: string
    previousAttempts: number
    workRunsBefore: number
  }> = []
  const candidates: Array<{
    task: ChiefTask
    state: ChiefTaskState
    actor: Persona
    previousOutput?: string
    previousAttempts: number
    workRunsBefore: number
    needsPrepare: boolean
  }> = []
  // Validate every task in wave order before preparing workspaces; no Actor starts until preparations settle.
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
    const previousAttempts = state.attempts
    const workRunsBefore =
      mission.operations?.runs.filter((run) => run.stage === "work" && run.taskId === task.id).length ?? 0
    const previousOutput = state.parallel ? undefined : state.output
    // An output is resumable only when it is bound to its original task workspace.
    if (!state.parallel) delete state.output
    const needsPrepare = !state.parallel || state.output === undefined
    candidates.push({ task, state, actor, previousOutput, previousAttempts, workRunsBefore, needsPrepare })
  }
  const toPrepare = candidates.filter((candidate) => candidate.needsPrepare)
  let waveBaseline: ParallelBaseline | undefined
  let baselineFailed = false
  if (toPrepare.length > 0 && parallel.prepareBaseline) {
    ports.signal?.throwIfAborted()
    try {
      waveBaseline = await parallel.prepareBaseline(mission)
    } catch (error) {
      ports.signal?.throwIfAborted()
      baselineFailed = true
      for (const candidate of toPrepare) {
        candidate.state.status = "pending"
        fail(candidate.task.id, error)
        if (hooks.fatal?.(error)) break
      }
      if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
        return wave.flatMap((task) => failures.get(task.id) ?? [])
    }
  }
  if (!baselineFailed && toPrepare.length > 0) {
    let prepareStopped = false
    const prepareOne = async (candidate: (typeof candidates)[number], signal?: AbortSignal) => {
      if (prepareStopped) return
      const { task, state } = candidate
      try {
        signal?.throwIfAborted()
        ports.signal?.throwIfAborted()
        const attempt = await serialize(() => {
          state.status = "running"
          state.attempts += 1
          return state.parallel?.attempt ?? state.attempts
        })
        const record =
          waveBaseline !== undefined
            ? await parallel.prepare(mission, task.id, attempt, waveBaseline)
            : await parallel.prepare(mission, task.id, attempt)
        await serialize(async () => {
          state.parallel = record
          await rawSave(
            "parallel-prepared",
            `Prepared ${task.id}, attempt ${state.attempts}, at ${record.path}.`,
            task.id,
          )
        })
      } catch (error) {
        await serialize(() => {
          state.status = "pending"
        })
        fail(task.id, error)
        if (hooks.fatal?.(error)) prepareStopped = true
      }
    }
    if (toPrepare.length === 1) {
      await prepareOne(toPrepare[0] as (typeof candidates)[number])
    } else {
      const prepareLimit = Math.max(
        1,
        Math.min(toPrepare.length, mission.executionPolicy?.maxParallel ?? toPrepare.length),
      )
      await runJoinedWave(toPrepare, (candidate, signal) => prepareOne(candidate, signal), ports.signal, prepareLimit)
    }
  }
  if (ports.signal?.aborted) {
    for (const candidate of candidates)
      if (!failures.has(candidate.task.id))
        fail(candidate.task.id, ports.signal.reason ?? new Error("Mission interrupted during parallel preparation."))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  }
  if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  for (const candidate of candidates) {
    if (failures.has(candidate.task.id) || !candidate.state.parallel) continue
    const workspace: Workspace = {
      ...mission.workspace,
      path: candidate.state.parallel.path,
      branch: candidate.state.parallel.branch,
    }
    prepared.push({
      task: candidate.task,
      state: candidate.state,
      actor: candidate.actor,
      workspace,
      previousOutput: candidate.previousOutput,
      previousAttempts: candidate.previousAttempts,
      workRunsBefore: candidate.workRunsBefore,
    })
  }
  const pending = prepared.filter(({ state }) => state.output === undefined)
  mission.status = "executing"
  // A wave may hold more ready tasks than Actor slots; the rest start as slots free up.
  const workSlots = Math.max(1, Math.min(pending.length, mission.executionPolicy?.maxParallel ?? pending.length))
  const slotContext = workSlots > 1 ? { parallelSlots: workSlots } : {}
  const results = await runJoinedWave(
    pending,
    async ({ task, state, actor, workspace, previousOutput }, signal) => {
      const promptMission = { ...mission, workspace }
      let prompt = workPrompt(promptMission, task, state, actor)
      if (previousOutput !== undefined)
        prompt += `\n\nPrevious Actor output (untrusted evidence for this new attempt):\n${JSON.stringify(previousOutput)}`
      const first = await hooks.run(actor, prompt, "work", task.id, {
        workspace,
        signal,
        ...slotContext,
      })
      // Feedback an Actor can act on arrives while it still holds its workspace, not a wave later: a failed
      // pre-delivery check returns to the same Actor without spending a repair round or a review.
      const output = await settlePreDeliveryCheck({
        check: ports.preDeliveryCheck,
        mission,
        workspacePath: workspace.path,
        taskId: task.id,
        output: first,
        rerun: (feedback) =>
          hooks.run(actor, `${prompt}\n\n${feedback}`, "work", task.id, { workspace, signal, ...slotContext }),
        save,
        signal,
      })
      applyWorkResult(task, state, output)
      await save(
        "parallel-output",
        `Actor ${actor.id} returned output for ${task.id}; isolated edits remain at ${workspace.path}.`,
        task.id,
      )
    },
    ports.signal,
    workSlots,
  )
  results.forEach((result, index) => {
    const entry = pending[index]
    if (entry && result.status === "rejected") {
      entry.state.status = "pending"
      if (
        result.reason instanceof MissionPause &&
        result.reason.kind === "actor-cooldown" &&
        (mission.operations?.runs.filter((run) => run.stage === "work" && run.taskId === entry.task.id).length ?? 0) ===
          entry.workRunsBefore
      )
        entry.state.attempts = entry.previousAttempts
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
      fail(task.id, error, "integration")
      if (hooks.fatal?.(error)) break
    }
  }
  if ([...failures.values()].some((failure) => hooks.fatal?.(failure.error)))
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  if (integrated.length > 0) await reclaimAppliedParallelWorkspaces(mission, parallel, save)
  // Integrated edits live in the mission workspace, its patch receipt, and retained Git evidence refs,
  // so the Actor repository (including its build output) is redundant whether review passed or not.
  // Callers run inside serialize(), so the retention checkpoint uses rawSave.
  const release = (taskId: string, record: NonNullable<ChiefTaskState["parallel"]>) =>
    parallel.dispose(record).catch(async (error: unknown) => {
      await rawSave(
        "parallel-retained",
        `Task ${taskId} Actor workspace was retained at ${record.path}: ${error instanceof Error ? error.message : String(error)}`,
        taskId,
      )
    })
  if (hooks.returned && integrated.length && !failures.size) {
    // The repair resets the tasks it names, so their workspace records are taken before it runs.
    const records = integrated.flatMap(({ task, state }) =>
      state.parallel ? [{ id: task.id, record: state.parallel }] : [],
    )
    if (await hooks.returned(integrated.map((entry) => entry.task))) {
      for (const { id, record } of records) await serialize(() => release(id, record))
      return []
    }
  }
  try {
    await recordIntegrationCheck(
      mission,
      ports,
      integrated.map((entry) => entry.state),
      save,
    )
  } catch (error) {
    for (const entry of integrated) fail(entry.task.id, error, "review")
    return wave.flatMap((task) => failures.get(task.id) ?? [])
  }
  // Reviews are read-only inspections of the integrated worktree: overlap them up to the parallel limit,
  // while every mission-state mutation and checkpoint stays on the shared serialized queue.
  const reviewLimit = Math.max(1, mission.executionPolicy?.maxParallel ?? 1)
  let reviewStopped = false
  await runJoinedWave(
    integrated,
    async ({ task, state }, signal) => {
      const record = state.parallel
      if (!record || reviewStopped) return
      try {
        signal.throwIfAborted()
        ports.signal?.throwIfAborted()
        await hooks.review(task, state)
        await serialize(async () => {
          if (state.review?.passed) {
            state.status = "completed"
            await rawSave(
              "task-completed",
              `Task ${task.id} passed independent review after parallel integration.`,
              task.id,
            )
            await release(task.id, record)
          } else {
            state.status = "pending"
            const reason = `Task ${task.id} failed independent review: ${state.review?.findings.join("; ") ?? "No passing review"}. Actor edits from ${record.path} remain integrated in the mission workspace.`
            await rawSave("parallel-review-rejected", reason, task.id)
            delete state.parallel
            delete state.changeSet
            delete state.output
            await rawSave(
              "parallel-repair-pending",
              `Task ${task.id} awaits the Chief's repair decision; the previous Actor patch and evidence refs remain in history.`,
              task.id,
            )
            await release(task.id, record)
            fail(task.id, new ParallelTaskReviewRejected(reason), "review")
          }
        })
      } catch (error) {
        await serialize(async () => {
          state.status = "reviewing"
          recordTaskReviewFailure(mission, task.id, error instanceof Error ? error.message : String(error))
        })
        fail(task.id, error, "review")
        if (hooks.fatal?.(error)) reviewStopped = true
      }
    },
    ports.signal,
    reviewLimit,
  )
  return wave.flatMap((task) => failures.get(task.id) ?? [])
}
