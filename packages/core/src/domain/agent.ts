/**
 * Canonical agent identifiers.
 *
 * This is the single source of truth for the actor/agent set. Capabilities,
 * binaries, environment forwarding, telemetry mapping, and the config enum all
 * derive from `AGENT_IDS` so adding a vendor cannot silently skip a table.
 */
export const AGENT_IDS = ["claude", "codex", "qwen", "antigravity", "cursor", "grok", "kimi", "opencode"] as const

export type AgentType = (typeof AGENT_IDS)[number]

export function isAgentType(value: string): value is AgentType {
  return (AGENT_IDS as readonly string[]).includes(value)
}
