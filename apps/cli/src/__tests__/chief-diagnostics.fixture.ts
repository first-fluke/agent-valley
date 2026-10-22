import type { Mission } from "@agent-valley/core/chief/types"

export function failureEvidence(mission: Mission): string {
  const uncertain = mission.operations?.runs.filter((run) => run.executionState === "unknown") ?? []
  return [mission.error, ...uncertain.map((run) => `${run.stage}: ${run.evidence}`)].filter(Boolean).join("\n")
}
