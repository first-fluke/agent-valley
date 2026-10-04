import { qwenProfilePath } from "./qwen-profile"

/** Home directories that may contain credentials for supported agent CLIs. */
const AGENT_HOME_PATHS: Record<string, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  qwen: [".qwen"],
  cursor: [".cursor"],
  grok: [".grok"],
  kimi: [".kimi-code"],
  antigravity: [".gemini"],
  gemini: [".gemini"],
  opencode: [".local/share/opencode", ".config/opencode"],
}

/** Unknown/custom agents receive no vendor credential directory by default. */
export function agentHomeAccess(
  agentType: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): { active: string[]; inactive: string[] } {
  const profile = agentType === "qwen" ? qwenProfilePath(home, env) : null
  const active =
    agentType === "qwen"
      ? profile
        ? [profile]
        : []
      : (AGENT_HOME_PATHS[agentType] ?? []).map((path) => `${home}/${path}`)
  const all = new Set(
    Object.values(AGENT_HOME_PATHS)
      .flat()
      .map((path) => `${home}/${path}`),
  )
  return {
    active,
    inactive: [...all].filter((path) => !active.includes(path)),
  }
}
