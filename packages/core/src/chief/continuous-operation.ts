import { createHash, randomUUID } from "node:crypto"
import { pendingCodeDelivery, successfulCodeDelivery } from "./code-delivery-contract"
import { containersHealthy, validateContainerObservation } from "./container-observation-state"
import { acceptContinuousChild } from "./continuous-acceptance"
import {
  type ContinuousDecision,
  continuousBaselineSchema,
  continuousDecisionSchema,
  type Operation,
  operationSchema,
} from "./continuous-contract"
import type { ContinuousOperationPorts } from "./continuous-operation-ports"
import {
  type AutomaticRecoveryContext,
  automaticMissionRecovery,
  automaticRecoveryLimit,
  scheduledChiefWait,
  verifiedMissionEvidence,
} from "./continuous-recovery"
import { assertExecutionDeadline, classifyFailure, MissionPause } from "./execution"
import { interruptionPause, isServiceShutdown } from "./service-shutdown"
import type { Mission } from "./types"

export type { ContinuousOperationPorts } from "./continuous-operation-ports"

export function continuousDecisionKey(
  decision: Extract<ContinuousDecision, { action: "execute" }>,
  observationFingerprint?: string,
  observationRevision?: number,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ goal: decision.goal, evidence: decision.evidence, observationFingerprint, observationRevision }),
    )
    .digest("hex")
}

/** The caller owns the operation lock; children own separate mission locks. */
export async function runContinuousOperation(
  operation: Operation,
  ports: ContinuousOperationPorts,
): Promise<Operation> {
  operationSchema.parse(operation)
  const now = () => (ports.now?.() ?? new Date()).toISOString()
  const save = async () => {
    operation.updatedAt = now()
    await ports.save(operation)
  }
  const pause = async (message: string) => {
    if (operation.phase !== "paused" && operation.phase !== "completed") operation.resumePhase = operation.phase
    operation.phase = "paused"
    const shutdown = isServiceShutdown(ports.signal)
    operation.pauseKind = shutdown ? "service-shutdown" : ports.signal?.aborted ? "interrupted" : "blocked"
    operation.error = (
      shutdown
        ? "The OS-owned service is shutting down. The operation retained its child, decision and recovery checkpoints for automatic resumption within their original limits."
        : message
    ).slice(0, 16_000)
    await save()
    return operation
  }
  const observe = async () => {
    if (!operation.containerObservationPolicy?.enabled) return false
    if (!ports.observeContainers)
      throw new Error("Restore the configured container observer before resuming this operation.")
    const previous = operation.containerObservation?.fingerprint
    const started = Date.parse(now())
    const snapshot = validateContainerObservation(
      operation.containerObservationPolicy,
      await ports.observeContainers(operation),
    )
    if (
      Date.parse(snapshot.collectedAt) < started - 1_000 ||
      Date.parse(snapshot.collectedAt) > Date.parse(now()) + 1_000
    )
      throw new Error(
        "Container observer returned stale or future evidence. Restore its clock and collect a fresh sample before resuming.",
      )
    operation.containerObservation = snapshot
    if (previous !== snapshot.fingerprint)
      operation.containerObservationRevision = (operation.containerObservationRevision ?? 0) + 1
    else operation.containerObservationRevision ??= 1
    await save()
    return previous !== operation.containerObservation.fingerprint
  }
  const waitForRecovery = async (nextRunAt?: string, mission?: Mission) => {
    while (nextRunAt && Date.parse(nextRunAt) > Date.parse(now()) && !ports.signal?.aborted) {
      if (mission) assertExecutionDeadline(mission, Date.parse(now()))
      const remaining =
        mission?.executionPolicy && mission.execution
          ? Date.parse(mission.execution.startedAt) + mission.executionPolicy.maxDurationSec * 1000 - Date.parse(now())
          : Infinity
      try {
        await ports.delay(Math.min(Date.parse(nextRunAt) - Date.parse(now()), remaining, 30_000), ports.signal)
      } catch (error) {
        if (mission) assertExecutionDeadline(mission, Date.parse(now()))
        if (error instanceof MissionPause && error.kind !== "interrupted" && error.kind !== "service-shutdown")
          throw error
        if (ports.signal?.aborted) throw interruptionPause(ports.signal, "Operation recovery interrupted.")
        throw error
      }
    }
    if (mission) assertExecutionDeadline(mission, Date.parse(now()))
    if (ports.signal?.aborted) throw interruptionPause(ports.signal, "Operation recovery interrupted.")
  }
  const recoverChild = async (mission: Mission, context?: AutomaticRecoveryContext) => {
    const disposition = automaticMissionRecovery(mission, Date.parse(now()), context)
    const previous =
      operation.recovery?.target === "child" && operation.recovery.checkpointId === mission.id
        ? operation.recovery
        : undefined
    const prior = previous?.attempts ?? 0
    const failedAttempts = previous?.failedAttempts ?? prior
    const waitKey = scheduledChiefWait(mission)
      ? createHash("sha256")
          .update(
            JSON.stringify({
              decision: mission.supervision?.decisions.at(-1),
              nextRunAt: mission.execution?.nextRunAt,
            }),
          )
          .digest("hex")
      : undefined
    const continuation = !!waitKey && waitKey !== previous?.waitContinuationKey
    operation.recovery = {
      target: "child",
      checkpointId: mission.id,
      attempts: prior,
      failedAttempts,
      ...(waitKey || previous?.waitContinuationKey
        ? { waitContinuationKey: waitKey ?? previous?.waitContinuationKey }
        : {}),
      disposition: disposition.retry ? "waiting" : "protected",
      reason: disposition.reason,
      ...(disposition.waitUntil ? { nextRunAt: disposition.waitUntil } : {}),
    }
    if (!disposition.retry) return false
    if (!continuation && failedAttempts >= automaticRecoveryLimit) {
      operation.recovery.disposition = "unresolved"
      operation.recovery.reason =
        "Bounded automatic child recovery exhausted its attempts; the original goal remains unresolved."
      return false
    }
    await save()
    await waitForRecovery(disposition.waitUntil, mission)
    const pendingRecovery = structuredClone(operation.recovery)
    operation.recovery.attempts += 1
    if (!continuation) operation.recovery.failedAttempts = failedAttempts + 1
    operation.recovery.disposition = "retrying"
    delete operation.recovery.nextRunAt
    await save()
    if (!operation.baseline) throw new Error("The original accepted baseline is missing from the recovery checkpoint.")
    try {
      const resumed = await ports.runMission(operation, mission.id, mission.goal, operation.baseline.path)
      if (isServiceShutdown(ports.signal) && resumed.execution?.failureKind === "service-shutdown") {
        operation.recovery = pendingRecovery
        throw interruptionPause(ports.signal, "Operation child recovery interrupted.")
      }
    } catch (error) {
      if (error instanceof MissionPause && error.kind === "service-shutdown") operation.recovery = pendingRecovery
      throw error
    }
    return true
  }
  let operatorDecisionRetry = ports.retryDecision === true
  const selectDecision = async (id: string): Promise<ContinuousDecision> => {
    while (true) {
      const explicitRetry = operatorDecisionRetry
      operatorDecisionRetry = false
      const previous =
        operation.recovery?.target === "decision" && operation.recovery.checkpointId === id
          ? structuredClone(operation.recovery)
          : undefined
      const prior =
        operation.recovery?.target === "decision" && operation.recovery.checkpointId === id
          ? operation.recovery.attempts
          : 0
      if (prior >= automaticRecoveryLimit && !explicitRetry)
        throw new Error(
          "Bounded automatic goal-selection recovery exhausted its attempts; the saved decision remains unresolved.",
        )
      await waitForRecovery(operation.recovery?.target === "decision" ? operation.recovery.nextRunAt : undefined)
      operation.recovery = {
        target: "decision",
        checkpointId: id,
        attempts: prior + 1,
        disposition: "retrying",
        reason: "Select or correct the original saved decision with its pinned evidence and Chief.",
      }
      await save()
      try {
        return continuousDecisionSchema.parse(await ports.decide(operation, id))
      } catch (error) {
        if (error instanceof MissionPause && error.kind === "service-shutdown") {
          operation.recovery = previous ?? {
            target: "decision",
            checkpointId: id,
            attempts: prior,
            disposition: "waiting",
            reason: error.message.slice(0, 16_000),
          }
          throw error
        }
        const reason = error instanceof Error ? error.message : String(error)
        const kind = error instanceof MissionPause ? error.kind : classifyFailure(reason)
        const invalid =
          error instanceof Error && (error.name === "ZodError" || reason.startsWith("Invalid Chief decision"))
        const retry = !(error instanceof MissionPause) && (invalid || kind === "provider" || kind === "rate-limit")
        operation.recovery.reason = reason.slice(0, 16_000)
        operation.recovery.disposition = retry ? "unresolved" : "protected"
        if (!retry || operation.recovery.attempts >= automaticRecoveryLimit) throw error
        operation.recovery.disposition = "waiting"
        operation.recovery.nextRunAt = new Date(Date.parse(now()) + Math.min(300_000, 1000 * 2 ** prior)).toISOString()
        await save()
      }
    }
  }
  if (operation.phase === "completed") return operation
  const observingResumedChild =
    ["paused", "running", "accepting"].includes(operation.phase) &&
    operation.recovery?.target === "child" &&
    operation.recovery.checkpointId === operation.currentMissionId &&
    operation.recovery.disposition === "protected" &&
    operation.recovery.reason === "The operation was cancelled; automatic recovery is stopped."
  if (observingResumedChild && operation.recovery)
    operation.recovery.reason =
      "Operation resumed; observing the original child checkpoint before deciding recovery. Its saved protections and spent limits remain in force."
  if (operation.phase === "paused") {
    operation.phase =
      operation.resumePhase ?? (operation.currentMissionId ? "running" : operation.nextRunAt ? "waiting" : "deciding")
    operation.resumePhase = undefined
    operation.pauseKind = undefined
    operation.error = undefined
    await save()
  } else if (observingResumedChild) await save()
  try {
    while (true) {
      if (ports.signal?.aborted)
        return pause(
          "Operation interrupted. Resume this operation when ready; its current child and decisions were retained.",
        )
      if (!operation.baseline) {
        const initial = continuousBaselineSchema.parse(await ports.accept(operation))
        if (
          initial.operationId !== operation.id ||
          initial.repositoryRoot !== operation.repositoryRoot ||
          initial.missionId
        )
          throw new Error(
            "Initial snapshot identity does not match this operation. Restore its original baseline receipt.",
          )
        operation.baseline = initial
        await save()
      }
      if (operation.currentMissionId) {
        const id = operation.currentMissionId
        const decision = operation.decision
        if (decision?.action !== "execute")
          throw new Error("Restore the saved child execution decision before resuming.")
        const assertIdentity = (child: Mission) => {
          if (child.id !== id || child.repositoryRoot !== operation.repositoryRoot || child.goal !== decision.goal)
            throw new Error(
              "Saved child identity, repository or goal does not match this operation. Restore the original child before continuing.",
            )
          if (JSON.stringify(child.containerObservationPolicy) !== JSON.stringify(operation.containerObservationPolicy))
            throw new Error(
              "Saved child container targets differ from the pinned operation contract. Restore the original child policy before continuing.",
            )
        }
        let mission = await ports.findMission(id)
        if (mission) {
          assertIdentity(mission)
          if (mission.tasks.some((task) => task.effectState === "unknown")) {
            if (await recoverChild(mission)) continue
            return pause(
              `Child ${id} has an unknown effect. ${operation.recovery?.reason} Its effects and checkpoint were retained.`,
            )
          }
          if (mission.status === "waiting") {
            if (await recoverChild(mission)) continue
            return pause(`Child ${id} is waiting and unresolved. ${operation.recovery?.reason}`)
          }
        }
        if (!mission) {
          if (operation.phase === "accepting")
            return pause(`Completed child ${id} is missing. Restore its saved mission record before continuing.`)
          mission = await ports.runMission(operation, id, decision.goal, operation.baseline.path)
        } else if (mission.status !== "completed" && mission.status !== "paused" && mission.status !== "failed") {
          const recovery = operation.recovery
          if (
            recovery?.target === "child" &&
            recovery.checkpointId === id &&
            recovery.disposition === "protected" &&
            !mission.tasks.some((task) => task.effectState === "running") &&
            automaticMissionRecovery(mission, Date.parse(now())).retry
          ) {
            recovery.disposition = "retrying"
            recovery.reason = `The original child resumed ${mission.status}; joining its saved coordinator without spending another recovery attempt.`
            await save()
          }
          mission = await ports.runMission(operation, id, decision.goal, operation.baseline.path)
        }
        assertIdentity(mission)
        if (mission.status !== "completed") {
          if (await recoverChild(mission)) continue
          return pause(
            `Child ${id} is unresolved (${mission.status}). ${mission.error ?? ""} ${operation.recovery?.reason ?? "Its original checkpoint was retained."}`,
          )
        }
        if (!verifiedMissionEvidence(mission) || mission.tasks.some((task) => task.effectState === "unknown")) {
          if (await recoverChild(mission)) continue
          return pause(
            `Completed child ${id} lacks a passing verification and final review or has an unknown effect. Restore and reconcile its verified mission record before accepting its snapshot.`,
          )
        }
        if (pendingCodeDelivery(mission)) {
          if (!mission.executionPolicy?.autoResume)
            return pause(`Child ${id} has pending code delivery with automatic recovery disabled.`)
          await waitForRecovery(mission.codeDelivery?.nextRunAt, mission)
          await ports.runMission(operation, id, decision.goal, operation.baseline.path)
          continue
        }
        if (!successfulCodeDelivery(mission))
          return pause(
            `Child ${id} has blocked code delivery. ${mission.codeDelivery?.error ?? "Preserve its delivery checkpoint before continuing."}`,
          )
        if (operation.containerObservationPolicy?.enabled) {
          if (
            !containersHealthy(mission.containerObservationPolicy, mission.containerObservation) ||
            mission.containerObservationVerifiedFingerprint !== mission.containerObservation?.fingerprint
          ) {
            if (await recoverChild(mission)) continue
            return pause(
              `Child ${id} passed code checks but has no verified service recovery. Resume the child and collect fresh health evidence before accepting it.`,
            )
          }
          validateContainerObservation(operation.containerObservationPolicy, mission.containerObservation)
          await observe()
          if (ports.signal?.aborted)
            return pause(
              "Operation interrupted during service observation. Its verified child was retained before acceptance.",
            )
          if (!containersHealthy(operation.containerObservationPolicy, operation.containerObservation)) {
            if (
              await recoverChild(mission, {
                completionEvidenceUnavailable: true,
                reason:
                  "Fresh service evidence is unresolved or unavailable; the Chief must review the same child's recovery.",
              })
            )
              continue
            return pause(
              `Child ${id} passed code checks and previously verified service recovery, but current service evidence is unresolved or unavailable. ${operation.recovery?.reason} Its child and external effects were retained.`,
            )
          }
        }
        await acceptContinuousChild(operation, mission, ports, save, now)
      }
      if (operation.cycleLimit !== undefined && operation.completedCycles >= operation.cycleLimit) {
        operation.phase = "completed"
        await save()
        return operation
      }
      if (operation.phase === "waiting") {
        const next = operation.nextRunAt ? Date.parse(operation.nextRunAt) : NaN
        if (!Number.isFinite(next)) throw new Error("Restore the operation's saved next decision timestamp.")
        while (next > Date.parse(now()) && !ports.signal?.aborted) {
          const poll = operation.containerObservationPolicy?.enabled
            ? Date.parse(operation.containerObservation?.nextPollAt ?? now())
            : Infinity
          if (poll <= Date.parse(now())) {
            if (await observe()) break
            continue
          }
          await ports.delay(Math.min(next - Date.parse(now()), poll - Date.parse(now()), 30_000), ports.signal)
        }
        if (ports.signal?.aborted)
          return pause("Operation interrupted while waiting. Its next decision time was retained.")
        operation.phase = "deciding"
        operation.nextRunAt = undefined
        operation.decisionId = undefined
        operation.decision = undefined
        operation.decisionObservation = undefined
        operation.decisionObservationRevision = undefined
        await save()
      }
      if (ports.signal?.aborted) return pause("Operation interrupted before goal selection. Resume when ready.")
      if (!operation.decisionId) {
        await observe()
        if (ports.signal?.aborted)
          return pause("Operation interrupted during service observation. Resume before selecting a new goal.")
        operation.decisionObservation = operation.containerObservation
        operation.decisionObservationRevision = operation.containerObservationRevision
        operation.decisionId = randomUUID()
        await save()
      }
      const decision = operation.decision ?? (await selectDecision(operation.decisionId))
      operation.decision = decision
      operation.recovery = undefined
      if (
        decision.action === "wait" ||
        continuousDecisionKey(
          decision,
          operation.decisionObservation?.fingerprint,
          operation.decisionObservationRevision,
        ) === operation.lastDecisionKey
      ) {
        if (decision.action === "execute")
          operation.decision = {
            action: "wait",
            reason:
              "The Chief repeated the previous goal and evidence. Wait for fresh evidence before selecting another improvement.",
          }
        operation.phase = "waiting"
        operation.nextRunAt = new Date(Date.parse(now()) + operation.waitIntervalSec * 1000).toISOString()
        await save()
        continue
      }
      operation.lastDecisionKey = continuousDecisionKey(
        decision,
        operation.decisionObservation?.fingerprint,
        operation.decisionObservationRevision,
      )
      operation.currentMissionId = randomUUID()
      operation.phase = "running"
      await save()
    }
  } catch (error) {
    if (operation.recovery && error instanceof MissionPause && error.kind !== "service-shutdown") {
      operation.recovery.disposition = "protected"
      operation.recovery.reason = error.message.slice(0, 16_000)
    }
    return pause(
      ports.signal?.aborted
        ? "Operation interrupted. Its current child and decision checkpoints were retained."
        : error instanceof Error
          ? error.message
          : String(error),
    )
  }
}
