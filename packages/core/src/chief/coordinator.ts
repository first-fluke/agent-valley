import { planPrompt, reviewPrompt, workPrompt } from "./prompts"
import { parsePlan, parseReview, validateMission } from "./schemas"
import type { ChiefPorts, ChiefStage, ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

const bounded = (value: string) => value.slice(-32_000)

/** Durable, sequential chief loop. Each adapter must await process termination before returning. */
export async function coordinate(mission: Mission, ports: ChiefPorts): Promise<Mission> {
  Object.assign(mission, validateMission(mission))
  const persona = (id: string): Persona => {
    const found = mission.personas.find((entry) => entry.id === id)
    if (!found) throw new Error(`Unknown persona ${id}. Restore the configured persona before resuming.`)
    return found
  }
  const checkAbort = () => {
    if (ports.signal?.aborted) throw new Error("Mission interrupted. Resume the saved mission to continue.")
  }
  const save = async (stage: string, message: string, taskId?: string) => {
    mission.updatedAt = new Date().toISOString()
    mission.history.push({ at: mission.updatedAt, stage, message, ...(taskId ? { taskId } : {}) })
    await ports.save(mission)
  }
  const invalidate = () => {
    for (const task of mission.tasks) {
      task.status = "pending"
      delete task.review
      delete task.fingerprint
    }
    delete mission.finalReview
    delete mission.verification
  }
  const run = async (actor: Persona, prompt: string, stage: ChiefStage): Promise<string> => {
    checkAbort()
    const before = await ports.fingerprint(mission)
    const output = await ports.runAgent(actor, prompt, mission, stage)
    checkAbort()
    const after = await ports.fingerprint(mission)
    if (stage !== "work" && before !== after) {
      throw new Error(
        `${stage} agent changed the worktree during a read-only stage. Inspect those changes before resuming.`,
      )
    }
    mission.fingerprint = after
    return output
  }
  const taskReview = async (task: ChiefTask, state: ChiefTaskState) => {
    state.status = "reviewing"
    mission.status = "reviewing"
    await save("review", `Reviewing ${task.id} with ${state.reviewerId}.`, task.id)
    state.review = parseReview(await run(persona(state.reviewerId), reviewPrompt(mission, task, state), "review"))
    state.fingerprint = mission.fingerprint
    await save("review", state.review.summary, task.id)
  }
  const performTask = async (task: ChiefTask, state: ChiefTaskState) => {
    while (state.status !== "completed") {
      checkAbort()
      state.status = "running"
      state.attempts += 1
      mission.status = "executing"
      await save("work", `Running ${task.id} with ${task.personaId}, attempt ${state.attempts}.`, task.id)
      state.output = bounded(
        await run(persona(task.personaId), workPrompt(mission, task, state, persona(task.personaId)), "work"),
      )
      await save("work", `Worker returned evidence for ${task.id}.`, task.id)
      await taskReview(task, state)
      if (state.review?.passed) {
        state.status = "completed"
        await save("task-completed", `Task ${task.id} passed independent review.`, task.id)
        continue
      }
      if ((state.repairRound ?? 0) >= mission.maxRepairs) {
        throw new Error(
          `Task ${task.id} failed review after ${mission.maxRepairs} repairs. Resolve the recorded findings before resuming.`,
        )
      }
      state.repairRound = (state.repairRound ?? 0) + 1
      state.status = "pending"
      await save("repair", `Repairing findings for ${task.id}.`, task.id)
    }
  }
  const requestRepair = async (reason: string) => {
    if ((mission.repairRound ?? 0) >= mission.maxRepairs) {
      throw new Error(
        `Mission failed after ${mission.maxRepairs} repair rounds: ${reason}. Inspect the evidence before resuming.`,
      )
    }
    mission.repairRound = (mission.repairRound ?? 0) + 1
    // Preserve rejection evidence in prompts; invalidate all task approvals because repair may affect dependencies.
    for (const task of mission.tasks) {
      task.status = "pending"
      delete task.fingerprint
    }
    await save("repair", reason)
  }

  try {
    checkAbort()
    const current = await ports.fingerprint(mission)
    mission.initialFingerprint ??= current
    if (mission.fingerprint && mission.fingerprint !== current) {
      invalidate()
      await save("resume", "Worktree changed since the checkpoint; all task reviews will run again.")
    }
    mission.fingerprint = current
    delete mission.error
    for (const task of mission.tasks) {
      if (task.status === "running" || task.status === "reviewing") task.status = "pending"
    }
    await save("resume", "Mission checkpoint loaded.")
    if (!mission.plan) {
      mission.status = "planning"
      await save("plan", "Chief is planning the mission.")
      mission.plan = parsePlan(await run(persona(mission.chiefId), planPrompt(mission), "plan"), mission.personas)
      mission.tasks = mission.plan.tasks.map((task) => {
        const reviewer =
          mission.personas.find((entry) => entry.id === "reviewer" && entry.id !== task.personaId) ??
          mission.personas.find((entry) => entry.id === mission.chiefId && entry.id !== task.personaId) ??
          mission.personas.find((entry) => entry.id !== task.personaId)
        if (!reviewer) throw new Error(`Task ${task.id} needs an independent reviewer. Configure a second persona.`)
        return { id: task.id, reviewerId: reviewer.id, status: "pending", attempts: 0 }
      })
      await save("plan", `Chief planned ${mission.tasks.length} tasks.`)
    }
    while (true) {
      checkAbort()
      while (mission.tasks.some((state) => state.status !== "completed")) {
        const task = mission.plan.tasks.find(
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
      mission.status = "verifying"
      await save("verify", "Running the operator's verification command.")
      checkAbort()
      const result = await ports.verify(mission)
      checkAbort()
      mission.fingerprint = await ports.fingerprint(mission)
      mission.verification = {
        ok: result.ok,
        output: result.output ? bounded(result.output) : undefined,
        fingerprint: mission.fingerprint,
      }
      if (mission.fingerprint === mission.initialFingerprint) {
        mission.verification.ok = false
        mission.verification.output =
          "No material deliverable changed in the worktree. Create the requested code or report artifact."
      }
      await save("verify", mission.verification.ok ? "Verification passed." : "Verification failed.")
      if (!mission.verification.ok) {
        await requestRepair(mission.verification.output ?? "The operator's verification command failed")
        continue
      }
      mission.status = "reviewing"
      await save("final-review", "Chief is reviewing the completed mission and verification evidence.")
      mission.finalReview = parseReview(await run(persona(mission.chiefId), reviewPrompt(mission), "final-review"))
      await save("final-review", mission.finalReview.summary)
      if (!mission.finalReview.passed) {
        await requestRepair(mission.finalReview.findings.join("; "))
        continue
      }
      if ((await ports.fingerprint(mission)) !== mission.verification.fingerprint) {
        throw new Error("Worktree changed after verification. Resume to rerun task reviews and verification.")
      }
      mission.status = "completed"
      await save(
        "completed",
        "Every task passed independent review, verification passed, and the chief approved the mission.",
      )
      return mission
    }
  } catch (error) {
    mission.status = "failed"
    mission.error = bounded(error instanceof Error ? error.message : String(error))
    await save("failed", mission.error)
    throw error
  }
}
