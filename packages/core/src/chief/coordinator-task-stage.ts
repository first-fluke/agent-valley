import { performParallelWave } from "./coordinator-parallel"
import { applyTaskReviewResult, applyWorkResult } from "./coordinator-results"
import type { CoordinatorContext, StageTransition } from "./coordinator-stages"
import { classifyFailure, MissionPause, pauseForFailure } from "./execution"
import { readyTaskWave } from "./parallel"
import { ParallelIntegrationConflict } from "./parallel-workspace"
import { reviewPrompt, workPrompt } from "./prompts"
import { selectTaskReviewer } from "./review-routing"
import { recordTaskVerdict } from "./routing"
import { parseReview } from "./schemas"
import type { ChiefTask, ChiefTaskState } from "./types"

export async function runTaskStage(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, checkpoint, run, persona, save, checkAbort, requestRecovery, protectedFailure } = context
  const taskReview = async (task: ChiefTask, state: ChiefTaskState) => {
    const reviewer = selectTaskReviewer(mission, task, state)
    state.status = "reviewing"
    await checkpoint.transition("reviewing", "review", `Reviewing ${task.id} with ${state.reviewerId}.`, task.id)
    const review = parseReview(await run(reviewer, reviewPrompt(mission, task, state), "review", task.id))
    applyTaskReviewResult(mission, state, review)
    await save("review", state.review.summary, task.id)
  }
  const performTask = async (task: ChiefTask, state: ChiefTaskState) => {
    while (state.status !== "completed") {
      checkAbort()
      state.status = "running"
      if (task.effectScope !== "external" || state.effectState !== "completed") state.attempts += 1
      if (task.effectScope === "external") state.effectState ??= "not-started"
      await checkpoint.transition(
        "executing",
        "work",
        `Running ${task.id} with ${task.personaId}, attempt ${state.attempts}.`,
        task.id,
      )
      try {
        if (task.effectScope === "external" && state.effectState === "unknown")
          throw new MissionPause(
            `External effect ${task.id} has no established destination outcome and will not be repeated.`,
            "unknown-effect",
          )
        if (task.effectScope !== "external" || state.effectState !== "completed") {
          const output = await run(
            persona(task.personaId),
            workPrompt(mission, task, state, persona(task.personaId)),
            "work",
            task.id,
          )
          applyWorkResult(task, state, output)
        }
        await save("work", `Worker returned evidence for ${task.id}.`, task.id)
        await taskReview(task, state)
      } catch (error) {
        recordTaskVerdict(mission, task.id, false, error instanceof Error ? error.message : String(error))
        if (!mission.supervision || protectedFailure(error)) throw error
        state.status = "pending"
        if (state.effectState !== "unknown")
          pauseForFailure(mission, error instanceof Error ? error.message : String(error), task.id)
        await requestRecovery(error instanceof Error ? error.message : String(error), task.id)
        return
      }
      if (state.review?.passed) {
        state.status = "completed"
        await save("task-completed", `Task ${task.id} passed independent review.`, task.id)
        continue
      }
      if (task.effectScope === "external") {
        await requestRecovery(
          `External action ${task.id} completed but failed independent review: ${state.review?.findings.join("; ")}. Preserve its completed effect; any new external repair requires a separate task.`,
          task.id,
        )
        return
      }
      if ((state.repairRound ?? 0) >= mission.maxRepairs) {
        if (mission.supervision) {
          await requestRecovery(
            `Task ${task.id} exhausted local repairs after independent review: ${state.review?.findings.join("; ")}`,
            task.id,
          )
          return
        }
        throw new Error(
          `Task ${task.id} failed review after ${mission.maxRepairs} repairs. Resolve the recorded findings before resuming.`,
        )
      }
      state.repairRound = (state.repairRound ?? 0) + 1
      state.status = "pending"
      await save("repair", `Repairing findings for ${task.id}.`, task.id)
    }
  }
  checkAbort()
  while (mission.tasks.some((state) => state.status !== "completed")) {
    const plan = mission.plan
    if (!plan) throw new Error("No task can run. Restore an acyclic plan with complete dependency state.")
    const limit = mission.executionPolicy?.maxParallel ?? 1
    const wave = readyTaskWave(plan, mission.tasks, limit).filter((task) => task.effectScope !== "external")
    if (
      ports.parallel &&
      limit > 1 &&
      (wave.length > 1 || wave.some((task) => mission.tasks.find((state) => state.id === task.id)?.parallel))
    ) {
      const failures = await performParallelWave(mission, ports, wave, {
        run,
        save,
        review: taskReview,
        fatal: protectedFailure,
      })
      const unrecoverable = failures.find((failure) => protectedFailure(failure.error))
      if (unrecoverable) throw unrecoverable.error
      for (const failure of failures) {
        recordTaskVerdict(mission, failure.taskId, false, failure.reason)
        pauseForFailure(mission, failure.reason, failure.taskId)
        const state = mission.tasks.find((task) => task.id === failure.taskId)
        if (!state) throw new Error("Recovery task disappeared. Restore the recorded plan.")
        if (
          failure.error instanceof ParallelIntegrationConflict ||
          ["environment", "authentication", "provider", "rate-limit"].includes(classifyFailure(failure.reason))
        ) {
          await requestRecovery(failure.reason, failure.taskId)
          break
        }
        if ((state.repairRound ?? 0) < mission.maxRepairs) {
          state.repairRound = (state.repairRound ?? 0) + 1
          await save("repair", failure.reason, failure.taskId)
        } else {
          await requestRecovery(failure.reason, failure.taskId)
          break
        }
      }
      continue
    }
    const task = plan.tasks.find(
      (entry) =>
        mission.tasks.some((state) => state.id === entry.id && state.status !== "completed") &&
        entry.dependencies.every((id) =>
          mission.tasks.some((state) => state.id === id && state.status === "completed"),
        ),
    )
    const state = mission.tasks.find((entry) => entry.id === task?.id)
    if (!task || !state) throw new Error("No task can run. Restore an acyclic plan with complete dependency state.")
    await performTask(task, state)
  }
  return { kind: "next", stage: mission.operatingPolicy?.reviewGates?.length ? "review-gates" : "verification" }
}
