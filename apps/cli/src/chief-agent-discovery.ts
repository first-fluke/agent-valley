import type { Mission } from "@agent-valley/core/chief/types"
import { type AgentAvailability, discoverAgents } from "./agent-discovery"

export async function discoverReadyAgents(
  discover: () => Promise<AgentAvailability[]> = discoverAgents,
): Promise<string[]> {
  const availability = await discover()
  return [
    ...new Set(
      availability
        .filter((agent) => agent.readiness === "ready" && agent.binaryPath?.trim())
        .map((agent) => agent.agentType),
    ),
  ]
}

export function resetHandoffForRetry(mission: Pick<Mission, "handoff">, retry?: boolean): void {
  if (retry === true) delete mission.handoff
}
