import { realpath } from "node:fs/promises"
import { runCommand } from "../workspace/worktree-lifecycle"
import type { Mission } from "./types"

export async function assertMissionWorkspace(mission: Mission): Promise<void> {
  const cwd = mission.workspace.path
  const [top, branch] = await Promise.all([
    runCommand("git", ["rev-parse", "--show-toplevel"], { cwd }),
    runCommand("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd }),
  ])
  const root = top.exitCode === 0 ? await realpath(top.stdout.trim()).catch(() => null) : null
  const current = await realpath(cwd).catch(() => null)
  if (
    !root ||
    root !== current ||
    branch.exitCode !== 0 ||
    branch.stdout.trim() !== mission.workspace.branch ||
    mission.workspace.issueId !== mission.id
  ) {
    throw new Error(
      `Mission ${mission.id} workspace is missing or is not on branch ${mission.workspace.branch}. Restore its Git metadata and branch at ${cwd} before resuming.`,
    )
  }
}
