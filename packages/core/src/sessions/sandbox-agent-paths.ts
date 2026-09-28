/** Home directories that may contain credentials for supported agent CLIs. */
const AGENT_HOME_PATHS: Record<string, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  cursor: [".cursor"],
  grok: [".grok"],
  kimi: [".kimi-code"],
  antigravity: [".gemini"],
  gemini: [".gemini"],
  opencode: [".local/share/opencode", ".config/opencode"],
}

/** Unknown/custom agents receive no vendor credential directory by default. */
export function agentHomeAccess(agentType: string, home: string): { active: string[]; inactive: string[] } {
  const active = new Set(AGENT_HOME_PATHS[agentType] ?? [])
  const all = new Set(Object.values(AGENT_HOME_PATHS).flat())
  return {
    active: [...active].map((path) => `${home}/${path}`),
    inactive: [...all].filter((path) => !active.has(path)).map((path) => `${home}/${path}`),
  }
}
