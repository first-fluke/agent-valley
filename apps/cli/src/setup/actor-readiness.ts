import type { AgentAvailability } from "../agent-discovery"

export function hasUnsupportedAuthProbe(state: AgentAvailability): boolean {
  return state.readiness === "unknown" && state.authStatusProbe === "unsupported" && Boolean(state.binaryPath)
}
