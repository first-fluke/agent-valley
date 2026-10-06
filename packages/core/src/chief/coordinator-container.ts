import {
  containerObservationLines,
  containersHealthy,
  validateContainerObservation,
} from "./container-observation-state"
import { MissionPause } from "./execution"
import type { ChiefPorts, Mission } from "./types"

export async function refreshMissionContainers(mission: Mission, ports: ChiefPorts): Promise<void> {
  if (!mission.containerObservationPolicy?.enabled) return
  if (!ports.observeContainers)
    throw new MissionPause(
      "Container observation is required for completion. Restore the Docker/Kubernetes observer and resume this mission.",
      "environment",
    )
  delete mission.containerObservationVerifiedFingerprint
  const started = Date.now()
  const snapshot = validateContainerObservation(
    mission.containerObservationPolicy,
    await ports.observeContainers(mission),
  )
  if (Date.parse(snapshot.collectedAt) < started - 1_000 || Date.parse(snapshot.collectedAt) > Date.now() + 1_000)
    throw new MissionPause(
      "Container observer returned stale or future evidence. Restore the observer clock and collect a fresh sample before resuming.",
      "environment",
    )
  mission.containerObservation = snapshot
}

/** Code verification and service recovery are separate completion requirements. */
export function missionContainerRecovery(mission: Mission): { healthy: boolean; reason: string } {
  if (!mission.containerObservationPolicy?.enabled)
    return { healthy: true, reason: "No enabled container observation policy." }
  const reason = containerObservationLines(mission.containerObservationPolicy, mission.containerObservation)
    .join("\n")
    .slice(0, 16_000)
  if (!mission.containerObservation)
    throw new MissionPause(
      "The configured container observer returned no validated evidence. Service recovery remains unresolved.",
      "environment",
    )
  const healthy = containersHealthy(mission.containerObservationPolicy, mission.containerObservation)
  if (healthy) mission.containerObservationVerifiedFingerprint = mission.containerObservation.fingerprint
  return { healthy, reason }
}

export async function verifyMissionContainers(
  mission: Mission,
  ports: ChiefPorts,
  save: (stage: string, message: string) => Promise<void>,
  checkAbort: () => void,
): Promise<{ healthy: boolean; reason: string }> {
  if (!mission.containerObservationPolicy?.enabled) return { healthy: true, reason: "No enabled container targets." }
  await refreshMissionContainers(mission, ports)
  checkAbort()
  await save("container-observation", "Collected fresh container evidence after code verification.")
  const recovery = missionContainerRecovery(mission)
  if (recovery.healthy)
    await save("container-recovery", "Configured services are running, ready and free of observed issues.")
  return recovery
}

export async function ensureCurrentMissionContainers(
  mission: Mission,
  ports: ChiefPorts,
  save: (stage: string, message: string) => Promise<void>,
  checkAbort: () => void,
  requestRecovery: (reason: string) => Promise<void>,
): Promise<boolean> {
  checkAbort()
  if (!mission.containerObservationPolicy?.enabled) return true
  const observation = mission.containerObservation
  if (
    observation &&
    Date.now() < Date.parse(observation.nextPollAt) &&
    mission.containerObservationVerifiedFingerprint === observation.fingerprint &&
    containersHealthy(mission.containerObservationPolicy, observation)
  )
    return true
  mission.status = "reviewing"
  const recovery = await verifyMissionContainers(mission, ports, save, checkAbort)
  if (recovery.healthy) return true
  delete mission.report
  await requestRecovery(`Configured service recovery changed before completion: ${recovery.reason}`)
  return false
}
