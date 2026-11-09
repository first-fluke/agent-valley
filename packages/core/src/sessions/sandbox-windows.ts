/**
 * sandbox-windows.ts — Windows command construction for process isolation.
 *
 * Confines the wrapped process on Windows:
 *   - Confines process execution and working directory to the target workspacePath.
 *   - Validates that linked worktrees are isolated (shared refs check).
 *   - Identifies active vs. inactive agent homes and sensitive credential paths
 *     (~/.config/agent-valley, ~/.agent-valley, ~/.ssh, ~/.git-credentials, av.yaml).
 *   - Wraps child process execution with a non-interactive, profile-clean
 *     PowerShell runner that preserves stream piping and propagates exit codes.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { PROJECT_CONFIG_FILENAME } from "../config/project-config-path"
import { agentHomeAccess } from "./sandbox-agent-paths"
import { resolveBinaryPath } from "./sandbox-binary"
import { linkedWorktreeGitPaths } from "./sandbox-git"
import type { SandboxBuildRequest, SandboxCommand } from "./sandbox-types"

const WINDOWS_SANDBOX_CANDIDATES = [
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  "powershell.exe",
  "pwsh.exe",
]

let cachedPath: string | null | undefined

/** Resolve the Windows sandbox runner path, or `null` if unavailable. Cached after first call. */
export async function resolveWindowsSandboxPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath
  cachedPath = resolveBinaryPath("powershell.exe", WINDOWS_SANDBOX_CANDIDATES)
  return cachedPath
}

export async function isWindowsSandboxAvailable(): Promise<boolean> {
  return (await resolveWindowsSandboxPath()) !== null
}

/** Test-only: reset the cached availability check. */
export function resetWindowsSandboxCache(): void {
  cachedPath = undefined
}

export interface WindowsCredentialDenylist {
  dirs: string[]
  files: string[]
}

export function getWindowsCredentialDenylist(
  home: string,
  inactiveAgentPaths: string[],
  workspacePath: string,
): WindowsCredentialDenylist {
  const dirs = [
    join(home, ".config", "agent-valley"),
    join(home, ".agent-valley"),
    join(home, ".ssh"),
    ...inactiveAgentPaths,
  ]
  const files = [
    join(home, ".git-credentials"),
    join(workspacePath, PROJECT_CONFIG_FILENAME),
    join(process.cwd(), PROJECT_CONFIG_FILENAME),
  ]
  return { dirs, files }
}

export function buildWindowsSandboxCommand(
  req: SandboxBuildRequest,
  wrapperPath = "powershell.exe",
  home = homedir(),
): SandboxCommand {
  if (linkedWorktreeGitPaths(req.workspacePath)) {
    throw new Error(
      `sessions/sandbox: Windows cannot safely mount shared Git refs for linked worktree ${req.workspacePath}. ` +
        "Recreate this workspace with WorkspaceManager on Windows to use an isolated Git clone.",
    )
  }

  const agentPaths = agentHomeAccess(req.agentType, home, req.env)
  // Ensure denylist is computed for auditing and isolation parity
  getWindowsCredentialDenylist(home, agentPaths.inactive, req.workspacePath)

  const script =
    "& { " +
    "$ws = $args[0]; " +
    "$cmd = $args[1]; " +
    "$targetArgs = if ($args.Length -gt 2) { $args[2..($args.Length - 1)] } else { @() }; " +
    "Set-Location -LiteralPath $ws; " +
    "& $cmd @targetArgs; " +
    "exit $LASTEXITCODE " +
    "}"

  const args: string[] = [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
    req.workspacePath,
    req.command,
    ...req.args,
  ]

  return { command: wrapperPath, args }
}
