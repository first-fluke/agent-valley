import { realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { nativeProfilePath } from "./native-profile"
import { qwenProfilePath } from "./qwen-profile"

/** Home directories that may contain credentials for supported agent CLIs. */
const AGENT_HOME_PATHS: Record<string, string[]> = {
  claude: [".claude"],
  codex: [".codex"],
  qwen: [".qwen"],
  dsh: [".dsh"],
  zcode: [".zcode"],
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
  env: Readonly<Record<string, string | undefined>> = {},
): { active: string[]; inactive: string[] } {
  const profile =
    agentType === "qwen"
      ? qwenProfilePath(home, env)
      : agentType === "dsh"
        ? nativeProfilePath(home, env, "DSH_HOME", ".dsh")
        : agentType === "zcode"
          ? nativeProfilePath(home, env, "ZCODE_DATA_BASE_DIR", ".zcode", ".zcode")
          : null
  const active =
    agentType === "codex"
      ? [codexProfilePath(home, env)]
      : agentType === "qwen" || agentType === "dsh" || agentType === "zcode"
        ? profile
          ? [profile]
          : []
        : (AGENT_HOME_PATHS[agentType] ?? []).map((path) => `${home}/${path}`)
  const all = new Set(
    Object.values(AGENT_HOME_PATHS)
      .flat()
      .map((path) => `${home}/${path}`),
  )
  // ZCode redirects provider/task data but keeps CLI resources under the original HOME.
  if (agentType === "zcode" && profile && !active.includes(`${home}/.zcode`)) active.push(`${home}/.zcode`)
  const providerConfig = env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE
  if (agentType === "zcode" && providerConfig && isAbsolute(providerConfig)) {
    // Native reads may normalize/migrate configuration using a sibling lock and atomic rename.
    const directory = nativeProfilePath(home, { providerConfig: dirname(providerConfig) }, "providerConfig", ".zcode")
    if (directory && !active.includes(directory)) active.push(directory)
  }
  return {
    active,
    inactive: [...all].filter((path) => !active.includes(path)),
  }
}

function codexProfilePath(home: string, env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.CODEX_HOME
  if (configured === undefined) return `${home}/.codex`
  if (!configured || !isAbsolute(configured)) {
    throw new Error(
      "sessions/sandbox: CODEX_HOME must name an absolute dedicated Codex profile directory. " +
        "Set CODEX_HOME to that directory in the Actor environment, or unset it to use ~/.codex.",
    )
  }

  let profile: string
  try {
    profile = realpathSync(configured)
    if (!statSync(profile).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new Error(
      "sessions/sandbox: CODEX_HOME must name an existing directory. " +
        "Create a dedicated Codex profile directory and set CODEX_HOME to its absolute path, or unset it to use ~/.codex.",
    )
  }

  let canonicalHome = resolve(home)
  try {
    canonicalHome = realpathSync(home)
  } catch {
    // Test and provisioned homes may not exist yet; still reject their ancestors.
  }
  const toHome = relative(profile, canonicalHome)
  if (toHome === "" || (toHome !== ".." && !toHome.startsWith(`..${sep}`) && !isAbsolute(toHome))) {
    throw new Error(
      "sessions/sandbox: CODEX_HOME must be a dedicated Codex profile directory, not the home directory or its ancestors. " +
        "Select a separate profile directory, or unset CODEX_HOME to use ~/.codex.",
    )
  }
  return profile
}
