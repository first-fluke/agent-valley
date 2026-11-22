import { lstat, readFile, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"
import { codeDeliveryPath } from "./code-delivery-contract"
import { parallelGit } from "./parallel-git"

export async function regularFile(path: string): Promise<Buffer | undefined> {
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) return undefined
  if (entry.isSymbolicLink() || !entry.isFile())
    throw new Error(
      "Source integration receipts must be regular local files. Restore their original bytes before retrying.",
    )
  return readFile(path)
}

export async function sourceRoot(repositoryRoot: string): Promise<string> {
  const root = await realpath(repositoryRoot)
  if (
    root !== resolve(repositoryRoot) ||
    (await realpath((await parallelGit(root, ["rev-parse", "--show-toplevel"])).trim())) !== root
  )
    throw new Error("Use the original canonical Git repository root for source integration.")
  return root
}

export function productPath(path: string): boolean {
  return (
    codeDeliveryPath(path) &&
    !path
      .split("/")
      .some(
        (part) =>
          /^\.(?:claude|codex|cursor|qwen|dsh|zcode|grok|kimi|gemini|opencode|kilo|kilocode|antigravity|mcp)(?:\.|$)/i.test(
            part,
          ) ||
          /^(?:opencode\.jsonc?|kilo\.jsonc?|mcp\.json|\.cursorrules|\.cursorignore|\.npmrc|\.pypirc|\.netrc|\.git-credentials)$/i.test(
            part,
          ) ||
          [".config", ".aws", ".ssh", ".azure"].includes(part) ||
          part === "AGENT_SETUP.md" ||
          part === "AGENTS.md" ||
          part === ".agent-vally",
      )
  )
}

/** Paths a cycle's source application wrote into the worktree; undefined when its receipt cannot be read. */
export async function appliedSourcePaths(
  root: string,
  operationId: string,
  missionId?: string,
): Promise<string[] | undefined> {
  if (!missionId) return []
  try {
    const saved = await regularFile(
      join(root, ".agent-valley", "operations", operationId, "source-integrations", missionId, "integration.json"),
    )
    if (!saved) return undefined
    const receipt = JSON.parse(saved.toString("utf8")) as Record<string, unknown>
    return [receipt.sourceChanges, receipt.changes].flatMap((changes) =>
      Array.isArray(changes)
        ? changes.flatMap((change) => (typeof change?.path === "string" ? [change.path] : []))
        : [],
    )
  } catch {
    return undefined
  }
}

/**
 * A same-branch fast-forward that proves nothing is left to reconcile: no uncommitted path was touched
 * by the moved commits or written by the last applied cycle. What stays uncommitted is then an edit the
 * operator keeps to themselves (a local config file), which a clean-worktree rule would mistake for an
 * applied cycle that was never committed.
 */
export async function sourceFastForward(
  root: string,
  saved: { branch: string; head: string },
  current: { branch: string; head: string },
  applied: string[] | undefined,
): Promise<boolean> {
  if (current.branch !== saved.branch) return false
  const forward = await parallelGit(root, ["merge-base", "--is-ancestor", saved.head, current.head]).then(
    () => true,
    () => false,
  )
  if (!forward) return false
  const listed = (out: string) => out.split("\0").filter(Boolean)
  const uncommitted = listed(await parallelGit(root, ["status", "--porcelain", "--no-renames", "-z"])).map((entry) =>
    entry.slice(3),
  )
  if (!uncommitted.length) return true
  if (!applied) return false
  const owned = [
    ...applied,
    ...listed(await parallelGit(root, ["diff", "--name-only", "--no-renames", "-z", saved.head, current.head])),
  ]
  // Status names an untracked directory once, with a trailing slash, for everything under it.
  return !uncommitted.some((path) =>
    owned.some((other) => other === path || (path.endsWith("/") && other.startsWith(path))),
  )
}
