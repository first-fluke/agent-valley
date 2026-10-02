import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Workspace } from "../domain/models"
import { isIsolatedGitWorkspace, runCommand } from "./worktree-lifecycle"

export async function importIsolatedBranch(workspace: Workspace, root: string): Promise<string | null> {
  if (!isIsolatedGitWorkspace(workspace)) return null
  const ref = `refs/heads/${workspace.branch}`
  const importedRef = `refs/agent-valley/imports/${randomUUID().replaceAll("-", "")}`
  // Fetch into a private ref first. Directly fetching cloneRef:sourceRef can
  // reject after the source branch was rebased, before retry objects arrive.
  const fetched = await runCommand("git", ["fetch", "--no-tags", workspace.path, `${ref}:${importedRef}`], {
    cwd: root,
  })
  if (fetched.exitCode !== 0) {
    return `Could not import ${workspace.branch} from isolated workspace: ${fetched.stderr.trim()}\n  Fix: Restore the issue branch before delivery.`
  }

  let temporaryWorktree: string | null = null
  let worktreeAdded = false
  try {
    const imported = await runCommand("git", ["rev-parse", "--verify", importedRef], { cwd: root })
    if (imported.exitCode !== 0) return `Could not read imported branch ${workspace.branch}.`
    const cloneHead = imported.stdout.trim()
    const current = await runCommand("git", ["rev-parse", "--verify", ref], { cwd: root })
    const currentHead = current.exitCode === 0 ? current.stdout.trim() : null
    if (!currentHead) {
      const created = await runCommand("git", ["update-ref", ref, cloneHead, "0".repeat(40)], { cwd: root })
      return created.exitCode === 0
        ? null
        : `Could not create source branch ${workspace.branch}: ${created.stderr.trim()}`
    }
    if (currentHead === cloneHead) return null
    if (
      (await runCommand("git", ["merge-base", "--is-ancestor", cloneHead, currentHead], { cwd: root })).exitCode === 0
    ) {
      return null
    }
    if (
      (await runCommand("git", ["merge-base", "--is-ancestor", currentHead, cloneHead], { cwd: root })).exitCode === 0
    ) {
      const updated = await runCommand("git", ["update-ref", ref, cloneHead, currentHead], { cwd: root })
      return updated.exitCode === 0 ? null : `Source branch ${workspace.branch} changed during import; retry delivery.`
    }

    const range = `${currentHead}...${cloneHead}`
    const merges = await runCommand("git", ["rev-list", "--right-only", "--merges", range], { cwd: root })
    if (merges.exitCode !== 0 || merges.stdout.trim()) {
      return `Retry branch ${workspace.branch} contains merge commits. Resolve the diverged branch manually before delivery.`
    }
    const replay = await runCommand(
      "git",
      ["rev-list", "--reverse", "--right-only", "--cherry-pick", "--no-merges", range],
      { cwd: root },
    )
    if (replay.exitCode !== 0) return `Could not compare retry commits for ${workspace.branch}: ${replay.stderr.trim()}`
    const commits = replay.stdout.trim().split("\n").filter(Boolean)
    if (commits.length === 0) return null

    temporaryWorktree = await mkdtemp(join(tmpdir(), "av-branch-import-"))
    const added = await runCommand("git", ["worktree", "add", "--detach", temporaryWorktree, currentHead], {
      cwd: root,
    })
    if (added.exitCode !== 0) return `Could not prepare retry import for ${workspace.branch}: ${added.stderr.trim()}`
    worktreeAdded = true
    for (const commit of commits) {
      const identity = await runCommand("git", ["show", "-s", "--format=%cn%x00%ce", commit], { cwd: root })
      const [name, email] = identity.stdout.trim().split("\0")
      if (identity.exitCode !== 0 || !name || !email)
        return `Could not read retry commit identity for ${workspace.branch}.`
      const picked = await runCommand("git", ["cherry-pick", commit], {
        cwd: temporaryWorktree,
        env: { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
      })
      if (picked.exitCode !== 0) {
        await runCommand("git", ["cherry-pick", "--abort"], { cwd: temporaryWorktree })
        return `Retry commit for ${workspace.branch} conflicts with the rebased branch: ${picked.stderr.trim()}\n  Fix: Reapply the change on the current branch before delivery.`
      }
    }
    const replayed = await runCommand("git", ["rev-parse", "HEAD"], { cwd: temporaryWorktree })
    if (replayed.exitCode !== 0) return `Could not read replayed retry branch ${workspace.branch}.`
    const updated = await runCommand("git", ["update-ref", ref, replayed.stdout.trim(), currentHead], { cwd: root })
    return updated.exitCode === 0
      ? null
      : `Source branch ${workspace.branch} changed during retry import; retry delivery.`
  } finally {
    if (temporaryWorktree) {
      if (worktreeAdded) await runCommand("git", ["worktree", "remove", "--force", temporaryWorktree], { cwd: root })
      await rm(temporaryWorktree, { recursive: true, force: true })
    }
    await runCommand("git", ["update-ref", "-d", importedRef], { cwd: root })
  }
}
