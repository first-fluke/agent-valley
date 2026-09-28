/** Git paths a linked worktree needs outside its working directory. */
import { readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export interface WorktreeGitPaths {
  gitDir: string
  commonDir: string
  objectsDir: string
  branchRef: string
  branchReflog: string
}

function within(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * Inspect Git's own worktree links before granting paths outside the workspace.
 * A regular repository already has its .git directory inside the writable
 * workspace. A malformed or unlinked .git file earns no extra permissions.
 */
export function linkedWorktreeGitPaths(workspacePath: string): WorktreeGitPaths | null {
  try {
    const workspace = realpathSync(workspacePath)
    const dotGit = join(workspace, ".git")
    if (!statSync(dotGit).isFile()) return null

    const pointer = readFileSync(dotGit, "utf8")
      .trim()
      .match(/^gitdir: (.+)$/)
    if (!pointer?.[1]) return null
    const gitDir = realpathSync(resolve(workspace, pointer[1]))
    const commonDir = realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()))
    if (dirname(gitDir) !== join(commonDir, "worktrees")) return null

    const backlink = readFileSync(join(gitDir, "gitdir"), "utf8").trim()
    if (resolve(gitDir, backlink) !== dotGit) return null

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim()
    if (!head.startsWith("ref: refs/heads/")) return null
    const branch = head.slice("ref: ".length)
    if (branch.split("/").some((part) => !part || part === "." || part === "..")) return null

    const branchRef = resolve(commonDir, branch)
    const branchReflog = resolve(commonDir, "logs", branch)
    if (!within(join(commonDir, "refs", "heads"), branchRef)) return null
    if (!within(join(commonDir, "logs", "refs", "heads"), branchReflog)) return null

    return { gitDir, commonDir, objectsDir: join(commonDir, "objects"), branchRef, branchReflog }
  } catch {
    return null
  }
}
