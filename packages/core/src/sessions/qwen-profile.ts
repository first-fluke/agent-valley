import { isAbsolute, join, relative, resolve } from "node:path"

/** QWEN_HOME names Qwen Code's user profile, not an API credential. Relative profiles vary per worktree. */
export function qwenProfilePath(home: string, env: NodeJS.ProcessEnv): string | null {
  const configured = env.QWEN_HOME
  if (!configured) return join(home, ".qwen")
  // `~` would make the entire home directory writable inside the sandbox.
  if (configured === "~") return null
  if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    return confinedProfile(resolve(home, configured.slice(2)), home)
  }
  return isAbsolute(configured) ? confinedProfile(resolve(configured), home) : null
}

/**
 * The profile path becomes a sandbox write allowlist entry. Reject the
 * filesystem root and any ancestor of $HOME (including $HOME itself): those
 * would turn filesystem confinement into near-full host write access.
 */
function confinedProfile(candidate: string, home: string): string | null {
  const relativeToHome = relative(candidate, resolve(home))
  const isAncestorOfHome = relativeToHome === "" || (!relativeToHome.startsWith("..") && !isAbsolute(relativeToHome))
  return isAncestorOfHome ? null : candidate
}
