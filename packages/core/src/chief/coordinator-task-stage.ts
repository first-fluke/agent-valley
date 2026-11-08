import { refreshActorCooldown } from "./actor-availability"
import { actorRouteHealth } from "./actor-health"
import { ParallelTaskReviewRejected, performParallelWave } from "./coordinator-parallel"
import { applyTaskReviewResult, applyWorkResult, recordTaskReviewFailure } from "./coordinator-results"
import type { CoordinatorContext, StageTransition } from "./coordinator-stages"
import { classifyFailure, MissionPause, pauseForFailure } from "./execution"
import { clearReviewerNoVerdict, handoffActor, noteReviewerNoVerdict } from "./handoff"
import { readyTaskWave } from "./parallel"
import { ParallelIntegrationConflict } from "./parallel-workspace"
import { reviewPrompt, workPrompt } from "./prompts"
import { selectTaskReviewer } from "./review-routing"
import { parseReview } from "./schemas"
import type { ChiefTask, ChiefTaskState, Persona } from "./types"

export async function runTaskStage(context: CoordinatorContext): Promise<StageTransition> {
  const { mission, ports, checkpoint, run, persona, save, checkAbort, requestRecovery, protectedFailure } = context
  // Review Actor calls overlap, but every mission-state mutation and checkpoint stays serialized so saved
  // checkpoints remain consistent across concurrent independent reviews.
  let mutationQueue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = mutationQueue.then(fn)
    mutationQueue = next.catch(() => {})
    return next
  }
  const MAX_REVIEW_ATTEMPTS = 4
  // Re-select a healthy reviewer after a route is retired; never spend a Chief recovery round here.
  const selectNextReviewer = (task: ChiefTask, state: ChiefTaskState, failed: string): Persona | undefined => {
    let candidate: Persona
    try {
      candidate = selectTaskReviewer(mission, task, state)
    } catch {
      return undefined
    }
    const effective = handoffActor(mission, candidate).agentType
    if (effective === failed) return undefined
    if (actorRouteHealth(mission, { actorType: effective }).state !== "ready") return undefined
    return candidate
  }
  const taskReview = async (task: ChiefTask, state: ChiefTaskState) => {
    for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt += 1) {
      const { reviewer, prompt } = await serialize(async () => {
        const reviewer = selectTaskReviewer(mission, task, state)
        state.status = "reviewing"
        await checkpoint.transition("reviewing", "review", `Reviewing ${task.id} with ${state.reviewerId}.`, task.id)
        return { reviewer, prompt: reviewPrompt(mission, task, state) }
      })
      let review: ReturnType<typeof parseReview>
      let response: string | undefined
      try {
        response = await run(reviewer, prompt, "review", task.id)
        review = parseReview(response)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        const decision = await serialize(async () => {
          recordTaskReviewFailure(mission, task.id, reason)
          await save(
            "review-pending",
            `Review for ${task.id} returned no verdict; successful work remains pending review. ${reason}`,
            task.id,
          )
          // Only transport/no-verdict failures count against a review route's health.
          if (error instanceof MissionPause || protectedFailure(error)) return { kind: "throw" as const }
          const activeRoute = mission.handoff?.routes[reviewer.id]
          // A configured reviewer's transport failure keeps the recovery semantics (automatic retry or
          // Chief wait). A response that parses to no verdict is different: the reviewer ran and answered
          // with prose, so retry once, then retire that route and use the next eligible reviewer instead
          // of spending a Chief recovery round that re-runs accepted work and reselects the same route.
          if (!activeRoute && response === undefined) return { kind: "throw" as const }
          const failed = activeRoute?.agentType ?? reviewer.agentType
          const { retired } = noteReviewerNoVerdict(mission, failed)
          const retryable = attempt + 1 < MAX_REVIEW_ATTEMPTS
          if (!retired) return retryable ? { kind: "retry" as const } : { kind: "throw" as const }
          if (!retryable) return { kind: "throw" as const }
          // Two no-verdict failures retired this route; route the review to the next eligible reviewer.
          const replacement = selectNextReviewer(task, state, failed)
          if (!replacement) return { kind: "throw" as const }
          mission.history.push({
            at: new Date().toISOString(),
            stage: "reviewer-fallback",
            taskId: task.id,
            message: `Review route ${failed} produced no verdict twice; next review uses ${handoffActor(mission, replacement).agentType} (${replacement.id}).`,
          })
          return { kind: "retry" as const }
        })
        if (decision.kind === "retry") continue
        throw error
      }
      await serialize(async () => {
        const route = mission.handoff?.routes[reviewer.id]?.agentType ?? reviewer.agentType
        clearReviewerNoVerdict(mission, route)
        applyTaskReviewResult(mission, state, review)
        await save("review", state.review.summary, task.id)
      })
      return
    }
    throw new Error(`Review for ${task.id} produced no verdict on every available reviewer route.`)
  }
  const performTask = async (task: ChiefTask, state: ChiefTaskState) => {
    while (state.status !== "completed") {
      checkAbort()
      const attemptsBefore = state.attempts
      const workRunsBefore =
        mission.operations?.runs.filter((run) => run.stage === "work" && run.taskId === task.id).length ?? 0
      const awaitingReview = state.output !== undefined && state.review === undefined
      state.status = awaitingReview ? "reviewing" : "running"
      if (!awaitingReview && (task.effectScope !== "external" || state.effectState !== "completed")) state.attempts += 1
      if (task.effectScope === "external") state.effectState ??= "not-started"
      if (!awaitingReview)
        await checkpoint.transition(
          "executing",
          "work",
          `Running ${task.id} with ${task.personaId}, attempt ${state.attempts}.`,
          task.id,
        )
      let reviewStarted = false
      try {
        if (task.effectScope === "external" && state.effectState === "unknown")
          throw new MissionPause(
            `External effect ${task.id} has no established destination outcome and will not be repeated.`,
            "unknown-effect",
          )
        if (!awaitingReview && (task.effectScope !== "external" || state.effectState !== "completed")) {
          const output = await run(
            persona(task.personaId),
            workPrompt(mission, task, state, persona(task.personaId)),
            "work",
            task.id,
          )
          applyWorkResult(task, state, output)
        }
        if (awaitingReview && state.parallel) {
          if (!ports.parallel)
            throw new Error(
              "Missing dependency: isolated task workspace ports. Configure parallel integration before reviewing retained Actor output.",
            )
          await ports.parallel.integrate(mission, state.parallel)
          mission.fingerprint = await ports.fingerprint(mission)
          await save(
            "parallel-integrated",
            `Integrated retained work for ${task.id}; independent review remains pending.`,
            task.id,
          )
        }
        if (!awaitingReview) await save("work", `Worker returned evidence for ${task.id}.`, task.id)
        reviewStarted = true
        await taskReview(task, state)
      } catch (error) {
        if (
          !reviewStarted &&
          error instanceof MissionPause &&
          error.kind === "actor-cooldown" &&
          (mission.operations?.runs.filter((run) => run.stage === "work" && run.taskId === task.id).length ?? 0) ===
            workRunsBefore
        )
          state.attempts = attemptsBefore
        if (!mission.supervision || protectedFailure(error)) throw error
        state.status = reviewStarted ? "reviewing" : "pending"
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
    const pendingReview = plan.tasks.find((task) => {
      const state = mission.tasks.find((entry) => entry.id === task.id)
      return (
        state &&
        state.status !== "completed" &&
        state.output !== undefined &&
        state.review === undefined &&
        !state.parallel &&
        task.dependencies.every((id) => mission.tasks.some((entry) => entry.id === id && entry.status === "completed"))
      )
    })
    const pendingState = mission.tasks.find((entry) => entry.id === pendingReview?.id)
    if (pendingReview && pendingState) {
      await performTask(pendingReview, pendingState)
      continue
    }
    const limit = mission.executionPolicy?.maxParallel ?? 1
    const wave = readyTaskWave(plan, mission.tasks, limit).filter((task) => task.effectScope !== "external")
    // A task whose isolated delivery was rejected keeps that delivery mode: its repair must produce a fresh
    // AV-captured changeSet, otherwise the review would compare a direct worktree edit against stale capture.
    const isolatedBefore = (taskId: string) =>
      mission.history.some((event) => event.taskId === taskId && event.stage === "parallel-review-rejected")
    if (
      ports.parallel &&
      limit > 1 &&
      (wave.length > 1 ||
        wave.some((task) => mission.tasks.find((state) => state.id === task.id)?.parallel || isolatedBefore(task.id)))
    ) {
      let failures = await performParallelWave(mission, ports, wave, {
        run,
        save,
        review: taskReview,
        fatal: protectedFailure,
        serialize,
      })
      // Resolve real failures first; a rejected sibling's old probe wait must not hide them.
      const primary = failures.filter(
        (failure) => !(failure.error instanceof MissionPause && failure.error.kind === "actor-cooldown"),
      )
      failures = primary.length
        ? primary
        : failures.flatMap((failure) => {
            const error = refreshActorCooldown(mission, failure.error)
            return error === undefined
              ? []
              : [{ ...failure, error, reason: error instanceof Error ? error.message : String(error) }]
          })
      const unrecoverable = failures.find((failure) => protectedFailure(failure.error))
      if (unrecoverable) throw unrecoverable.error
      for (const failure of failures) {
        pauseForFailure(mission, failure.reason, failure.taskId)
        const state = mission.tasks.find((task) => task.id === failure.taskId)
        if (!state) throw new Error("Recovery task disappeared. Restore the recorded plan.")
        if (
          (failure.phase === "review" && !(failure.error instanceof ParallelTaskReviewRejected)) ||
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
