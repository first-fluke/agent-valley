/**
 * Workspace root selection. Shared by Linear and GitHub flows.
 */

import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { runCommand } from "@agent-valley/core/workspace/worktree-lifecycle"
import * as p from "@clack/prompts"
import { CANCEL, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

export async function validateOrderWorkspace(path: string): Promise<string | undefined> {
  if (!isAbsolute(path)) return "Set workspace.root in av.yaml to an absolute Git repository path."
  try {
    if (!statSync(path).isDirectory()) return "Choose an existing Git repository directory for workspace.root."
  } catch {
    return `Repository ${path} does not exist. Clone or create and commit a Git repository first, then rerun av setup.`
  }
  const repository = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: path })
  if (repository.exitCode !== 0 || repository.stdout.trim() !== "true") {
    return `Repository ${path} is not a readable Git worktree. Install Git and choose an existing Git repository.`
  }
  const commit = await runCommand("git", ["rev-parse", "--verify", "HEAD^{commit}"], { cwd: path })
  if (commit.exitCode !== 0)
    return `Repository ${path} has no commit. Create an initial Git commit, then rerun av setup.`
  return undefined
}

export async function stepWorkspace(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const defaultWorkspace =
    ctx.workspaceRoot ?? (ctx.trackerKind === "none" ? process.cwd() : `${process.env.HOME}/workspaces`)

  while (true) {
    const workspaceRoot = await p.text({
      message: stepLabel(
        step,
        total,
        ctx.trackerKind === "none" ? "Target Git repository (absolute)" : "Agent workspace path (absolute)",
      ),
      placeholder: defaultWorkspace,
      initialValue: defaultWorkspace,
      validate: (v) => {
        if (!v?.trim()) return "Required"
        if (!isAbsolute(v.trim())) return "Must be an absolute path"
      },
    })
    if (p.isCancel(workspaceRoot)) return CANCEL
    const root = workspaceRoot.trim()
    if (ctx.trackerKind === "none") {
      const error = await validateOrderWorkspace(root)
      if (error) {
        p.log.error(error)
        continue
      }
    }

    ctx.workspaceRoot = root
    return
  }
}
