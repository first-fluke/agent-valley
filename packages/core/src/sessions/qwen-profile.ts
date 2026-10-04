import { isAbsolute, join, resolve } from "node:path"

/** QWEN_HOME names Qwen Code's user profile, not an API credential. Relative profiles vary per worktree. */
export function qwenProfilePath(home: string, env: NodeJS.ProcessEnv): string | null {
  const configured = env.QWEN_HOME
  if (!configured) return join(home, ".qwen")
  if (configured === "~") return home
  if (configured.startsWith("~/") || configured.startsWith("~\\")) return resolve(home, configured.slice(2))
  return isAbsolute(configured) ? resolve(configured) : null
}
