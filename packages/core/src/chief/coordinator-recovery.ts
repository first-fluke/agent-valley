import type { createMissionRun } from "./coordinator-run"
import { assertExecutionDeadline, executionState, MissionPause, progressKey, recordPause } from "./execution"
import { supervisePrompt } from "./prompts"
import { parseSupervisionResponse } from "./schemas"
import { applyRecovery, recordDecision } from "./supervision"
import type { ChiefPorts, Mission, Persona } from "./types"

interface RecoveryHooks {
  run: ReturnType<typeof createMissionRun>
  persona(id: string): Persona
  save(stage: string, message: string, taskId?: string): Promise<void>
  checkAbort(): void
}

export function createChiefRecovery(mission: Mission, ports: ChiefPorts, hooks: RecoveryHooks) {
  return async (reason: string, taskId?: string): Promise<void> => {
    const supervision = mission.supervision
    if (!supervision) throw new Error(reason)
    hooks.checkAbort()
    assertExecutionDeadline(mission)
    supervision.pendingRecovery = { reason: reason.slice(-32_000), ...(taskId ? { taskId } : {}) }
    await hooks.save("recovery-requested", reason, taskId)
    const fingerprint = await ports.fingerprint(mission)
    const progress = progressKey(mission, fingerprint)
    const priorProgress = mission.execution?.progressKey
    if (priorProgress && priorProgress !== progress) supervision.stalledRounds = 0
    if (mission.executionPolicy) executionState(mission).progressKey = progress
    if (supervision.stalledRounds >= 3)
      throw new MissionPause(
        "Chief Director supervision stalled for three rounds without changed evidence. The original goal remains unresolved.",
        "budget",
      )
    if (supervision.rounds >= supervision.maxRounds)
      throw new MissionPause(
        `Chief Director supervision exhausted ${supervision.maxRounds} rounds. The original goal remains unresolved: ${reason}`,
        "budget",
      )
    const previousStalled = supervision.stalledRounds
    const unchanged = priorProgress ? priorProgress === progress : supervision.lastFingerprint === fingerprint
    supervision.stalledRounds =
      unchanged && supervision.decisions.at(-1)?.action !== "wait"
        ? previousStalled + 1
        : unchanged
          ? previousStalled
          : 0
    supervision.lastFingerprint = fingerprint
    supervision.rounds += 1
    mission.status = "planning"
    await hooks.save(
      "supervise",
      `Chief Director recovery round ${supervision.rounds}/${supervision.maxRounds}.`,
      taskId,
    )
    if (supervision.stalledRounds >= 3)
      throw new MissionPause(
        "Chief Director supervision stalled for three rounds without changed evidence. The original goal remains unresolved.",
        "budget",
      )
    const response = parseSupervisionResponse(
      await hooks.run(hooks.persona(mission.chiefId), supervisePrompt(mission), "supervise"),
      mission,
    )
    const decision = recordDecision(mission, response, fingerprint)
    if (response.action === "stop") {
      delete supervision.pendingRecovery
      await hooks.save("supervise-stop", response.reason, taskId)
      throw new Error(`Chief Director stopped before achieving the goal: ${response.reason}`)
    }
    if (response.action === "wait") {
      supervision.stalledRounds = previousStalled
      if (!mission.tasks.some((task) => task.effectState === "unknown")) delete supervision.pendingRecovery
      const nextRunAt = new Date(Date.parse(decision.at) + response.retryAfterSec * 1_000).toISOString()
      const pause = new MissionPause(`Chief Director is waiting: ${response.reason}`, "chief-wait", nextRunAt)
      recordPause(mission, pause)
      await hooks.save("supervise-wait", response.reason, taskId)
      throw pause
    }
    applyRecovery(mission, response)
    delete supervision.pendingRecovery
    await hooks.save("supervise", response.reason, taskId)
  }
}
