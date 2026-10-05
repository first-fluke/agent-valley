import { createHash, randomUUID } from "node:crypto"
import type { ContainerObservationSnapshot } from "./container-observation-policy"
import { containersHealthy, validateContainerObservation } from "./container-observation-state"
import {
  type ContinuousBaseline,
  type ContinuousDecision,
  continuousBaselineSchema,
  continuousDecisionSchema,
  type Operation,
  operationSchema,
} from "./continuous-contract"
import type { Mission } from "./types"

export interface ContinuousOperationPorts {
  decide(operation: Operation, decisionId: string): Promise<ContinuousDecision>
  findMission(id: string): Promise<Mission | undefined>
  runMission(operation: Operation, id: string, goal: string, baselinePath: string): Promise<Mission>
  accept(operation: Operation, mission?: Mission): Promise<ContinuousBaseline>
  save(operation: Operation): Promise<void>
  delay(milliseconds: number, signal?: AbortSignal): Promise<void>
  observeContainers?(operation: Operation): Promise<ContainerObservationSnapshot>
  now?: () => Date
  signal?: AbortSignal
}

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
    operation.error = message.slice(0, 16_000)
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
  if (operation.phase === "completed") return operation
  if (operation.phase === "paused") {
    operation.phase =
      operation.resumePhase ?? (operation.currentMissionId ? "running" : operation.nextRunAt ? "waiting" : "deciding")
    operation.resumePhase = undefined
    operation.error = undefined
    await save()
  }
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
          if (mission.tasks.some((task) => task.effectState === "unknown"))
            return pause(
              `Child ${id} has an unknown effect. Reconcile that mission's effect state before continuing this operation.`,
            )
        }
        if (!mission) {
          if (operation.phase === "accepting")
            return pause(`Completed child ${id} is missing. Restore its saved mission record before continuing.`)
          mission = await ports.runMission(operation, id, decision.goal, operation.baseline.path)
        } else if (mission.status !== "completed" && mission.status !== "paused" && mission.status !== "failed") {
          mission = await ports.runMission(operation, id, decision.goal, operation.baseline.path)
        }
        assertIdentity(mission)
        if (mission.status !== "completed")
          return pause(
            `Child ${id} is ${mission.status}. ${mission.error ?? "Inspect av status and reconcile or resume that mission before continuing this operation."}`,
          )
        if (
          !mission.verification?.ok ||
          !mission.finalReview?.passed ||
          mission.tasks.some((task) => task.effectState === "unknown")
        )
          return pause(
            `Completed child ${id} lacks a passing verification and final review or has an unknown effect. Restore and reconcile its verified mission record before accepting its snapshot.`,
          )
        if (operation.containerObservationPolicy?.enabled) {
          if (
            !containersHealthy(mission.containerObservationPolicy, mission.containerObservation) ||
            mission.containerObservationVerifiedFingerprint !== mission.containerObservation?.fingerprint
          )
            return pause(
              `Child ${id} passed code checks but has no verified service recovery. Resume the child and collect fresh health evidence before accepting it.`,
            )
          validateContainerObservation(operation.containerObservationPolicy, mission.containerObservation)
          await observe()
          if (ports.signal?.aborted)
            return pause(
              "Operation interrupted during service observation. Its verified child was retained before acceptance.",
            )
          if (!containersHealthy(operation.containerObservationPolicy, operation.containerObservation))
            return pause(
              `Child ${id} passed code checks and previously verified service recovery, but current service evidence is unresolved or unavailable. Restore service health before resuming this operation; its child and external effects were retained.`,
            )
        }
        operation.phase = "accepting"
        await save()
        const baseline = continuousBaselineSchema.parse(await ports.accept(operation, mission))
        if (
          baseline.operationId !== operation.id ||
          baseline.repositoryRoot !== operation.repositoryRoot ||
          baseline.missionId !== id
        )
          throw new Error(
            "Accepted snapshot identity does not match the completed child. Restore its snapshot receipt before continuing.",
          )
        operation.baseline = baseline
        operation.completedCycles += 1
        operation.history = [
          ...operation.history,
          {
            missionId: id,
            goal: decision.goal,
            reason: decision.reason,
            evidence: decision.evidence,
            completedAt: now(),
            baselinePath: baseline.path,
          },
        ].slice(-20)
        operation.currentMissionId = undefined
        operation.decisionId = undefined
        operation.decision = undefined
        operation.decisionObservation = undefined
        operation.decisionObservationRevision = undefined
        operation.nextRunAt = undefined
        operation.phase = "deciding"
        await save()
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
      const decision =
        operation.decision ?? continuousDecisionSchema.parse(await ports.decide(operation, operation.decisionId))
      operation.decision = decision
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
    return pause(
      ports.signal?.aborted
        ? "Operation interrupted. Its current child and decision checkpoints were retained."
        : error instanceof Error
          ? error.message
          : String(error),
    )
  }
}
