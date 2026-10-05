import type { RefinementCtx } from "zod"
import {
  type ContainerObservationPolicy,
  type ContainerObservationSnapshot,
  containerObservationSnapshotSchema,
  containerTargetHealthy,
} from "./container-observation-policy"
import type { Mission } from "./types"

/** Evidence must cover exactly the operator's pinned targets, including unavailable sources. */
export function validateContainerObservation(
  policy: ContainerObservationPolicy | undefined,
  value: unknown,
): ContainerObservationSnapshot {
  const snapshot = containerObservationSnapshotSchema.parse(value)
  if (!policy) throw new Error("Container evidence has no pinned observation policy. Restore its original targets.")
  const expected = policy.enabled ? policy.targets : []
  if (
    snapshot.results.length !== expected.length ||
    new Set(snapshot.results.map((result) => result.targetId)).size !== snapshot.results.length ||
    expected.some(
      (target) => !snapshot.results.some((result) => result.targetId === target.id && result.kind === target.kind),
    )
  )
    throw new Error(
      "Container evidence does not match the pinned target IDs and kinds. Restore the original observation record.",
    )
  if (Date.parse(snapshot.nextPollAt) <= Date.parse(snapshot.collectedAt))
    throw new Error("Container observation requires a next poll after its collection timestamp.")
  return snapshot
}

export function containersHealthy(
  policy: ContainerObservationPolicy | undefined,
  snapshot: ContainerObservationSnapshot | undefined,
): boolean {
  if (!policy?.enabled) return true
  if (!snapshot) return false
  try {
    return validateContainerObservation(policy, snapshot).results.every(containerTargetHealthy)
  } catch {
    return false
  }
}

export function containerObservationLines(
  policy: ContainerObservationPolicy | undefined,
  snapshot: ContainerObservationSnapshot | undefined,
): string[] {
  if (!policy?.enabled) return []
  if (!snapshot)
    return ["Configured service recovery has not been observed. Passing code checks do not establish service recovery."]
  return [
    `Container observation: ${snapshot.collectedAt}; fingerprint ${snapshot.fingerprint}; next poll ${snapshot.nextPollAt}`,
    ...snapshot.results.flatMap((result) => [
      `${result.targetId} (${result.kind}): ${containerTargetHealthy(result) ? "healthy" : result.status === "unavailable" ? "unavailable" : "unresolved"}; state=${result.state ?? "unknown"}; ready=${result.ready ?? "unknown"}; health=${result.health ?? "unknown"}; restarts=${result.restartCount ?? "unknown"}; exit=${result.exitCode ?? "unknown"}; OOM=${result.oomKilled ?? "unknown"}; logs=${result.logsAvailable ?? "unknown"}; stats=${result.statsAvailable ?? "unknown"}${result.cpuPercent !== undefined ? `; CPU=${result.cpuPercent}% (threshold ${policy.cpu_percent_threshold ?? "not configured"})` : ""}${result.memoryPercent !== undefined ? `; memory=${result.memoryPercent}% (threshold ${policy.memory_percent_threshold ?? "not configured"})` : ""}${result.issues.length ? `; issues=${result.issues.join(",")}` : ""}${result.reason ? `; ${result.reason}` : ""}`,
      ...(result.logExcerpt ? [`${result.targetId} sanitized recent logs: ${result.logExcerpt.slice(-2_000)}`] : []),
    ]),
  ]
}

export function containerCompletionVerified(mission: Mission): boolean {
  return (
    !mission.containerObservationPolicy?.enabled ||
    (containersHealthy(mission.containerObservationPolicy, mission.containerObservation) &&
      mission.containerObservationVerifiedFingerprint === mission.containerObservation?.fingerprint)
  )
}

export function containerObservationReport(mission: Mission, render: (value: string) => string): string[] {
  return containerObservationLines(mission.containerObservationPolicy, mission.containerObservation).map(
    (line) => `- ${render(line)}`,
  )
}

export function refineMissionContainerState(
  mission: Pick<
    Mission,
    "containerObservationPolicy" | "containerObservation" | "containerObservationVerifiedFingerprint"
  >,
  context: RefinementCtx,
): void {
  if (mission.containerObservation) {
    try {
      validateContainerObservation(mission.containerObservationPolicy, mission.containerObservation)
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["containerObservation"],
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (
    mission.containerObservationVerifiedFingerprint &&
    mission.containerObservationVerifiedFingerprint !== mission.containerObservation?.fingerprint
  )
    context.addIssue({
      code: "custom",
      path: ["containerObservationVerifiedFingerprint"],
      message: "Service recovery evidence differs from the verified container observation.",
    })
}
