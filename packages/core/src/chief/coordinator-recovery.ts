import { AgentRunError } from "../domain/ports/agent-runner"
import { carryOpenFindings } from "./carried-findings"
import type { createMissionRun } from "./coordinator-run"
import {
  assertExecutionDeadline,
  assertNoUncertainExecution,
  executionState,
  isProviderOutage,
  MissionPause,
  outagePause,
  progressKey,
  recordPause,
} from "./execution"
import { isHostSleepArtefact } from "./host-suspension"
import { supervisePrompt } from "./prompts"
import { parseSupervisionResponse } from "./schemas"
import { runStructuredStage } from "./structured-stage"
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
    assertNoUncertainExecution(mission)
    const supervision = mission.supervision
    if (!supervision) throw new Error(reason)
    delete supervision.verificationFailureKey
    hooks.checkAbort()
    assertExecutionDeadline(mission)
    // An unreachable provider leaves the Chief nothing to decide and no way to answer. The failed call is
    // retried when the provider is back; no recovery is recorded, so the resumed mission repeats that call.
    const asleep = isHostSleepArtefact(reason)
    if (asleep || isProviderOutage(reason)) {
      delete supervision.pendingRecovery
      const pause = outagePause(reason)
      recordPause(mission, pause)
      await hooks.save(
        "supervise-wait",
        `${asleep ? "The host was suspended during the call" : "The provider is unreachable"} (${reason.slice(0, 300)}). No Chief Director recovery round is spent; the failed call is retried at ${pause.nextRunAt}.`,
        taskId,
      )
      throw pause
    }
    // Findings left after the last local repair move to a later task instead of costing a recovery round.
    const carried = taskId ? carryOpenFindings(mission, taskId) : undefined
    if (carried) {
      delete supervision.pendingRecovery
      await hooks.save("task-carried", carried, taskId)
      return
    }
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
    // One invalid recovery decision used to fail the whole mission; like planning, it gets one corrected attempt.
    const response = await runStructuredStage({
      mission,
      stage: "supervise",
      prompt: supervisePrompt(mission),
      scopeKey: `${supervision.rounds}:${fingerprint}`,
      run: (prompt) => hooks.run(hooks.persona(mission.chiefId), prompt, "supervise"),
      parse: (output) => parseSupervisionResponse(output, mission),
      save: (stage, message) => hooks.save(stage, message, taskId),
    }).catch(async (error: unknown) => {
      const failure = error instanceof Error ? error.message : String(error)
      if (
        error instanceof MissionPause ||
        (error instanceof AgentRunError && error.outcomeUnknown) ||
        !(isProviderOutage(failure) || isHostSleepArtefact(failure))
      )
        throw error
      // The Chief never answered, so this round decided nothing: it is returned and the saved recovery
      // request is asked again when the provider is back.
      supervision.rounds -= 1
      supervision.stalledRounds = previousStalled
      const pause = outagePause(failure)
      recordPause(mission, pause)
      await hooks.save(
        "supervise-wait",
        `The Chief Director could not be reached (${failure.slice(0, 300)}). Recovery round ${supervision.rounds + 1} is not spent; the same request is asked again at ${pause.nextRunAt}.`,
        taskId,
      )
      throw pause
    })
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
