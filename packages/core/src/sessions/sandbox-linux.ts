/**
 * sandbox-linux.ts — bubblewrap (`bwrap`) command construction for Linux.
 *
 * Confines the wrapped process to:
 *   - Read-only view of standard system roots (/usr, /bin, /sbin, /lib,
 *     /lib64, /etc, /opt, /var) plus a read-only view of $HOME.
 *   - Read-write access to the workspace directory + a curated set of
 *     per-agent-CLI cache/config directories under $HOME (bound AFTER the
 *     read-only $HOME mount so they override it) + the OS tmp dir.
 *
 * GAP (documented, not silently swallowed — see docs/harness/SAFETY.md
 * and the sandbox result doc): bubblewrap's own primitives cannot enforce
 * a domain-scoped network egress allowlist without root (a network
 * namespace + owner-matched iptables/nftables rules, or a local forward
 * proxy that the agent CLI would need to be pointed at via HTTP(S)_PROXY
 * env vars). Doing that correctly is out of scope for this pass — the
 * wrapped process here keeps full host network access. Only filesystem
 * confinement is enforced on Linux today. This is the residual gap
 * called out in the task description ("On platforms where per-process
 * egress filtering isn't feasible without root, document the limitation
 * and at minimum confine filesystem").
 */

import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { resolveBinaryPath } from "./sandbox-binary"
import type { SandboxBuildRequest, SandboxCommand } from "./sandbox-types"

const READONLY_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt", "/var"]

let cachedPath: string | null | undefined

/** Resolve the bwrap binary path, or `null` if unavailable. Cached after first call. */
export async function resolveBwrapPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath
  cachedPath = resolveBinaryPath("bwrap", ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"])
  return cachedPath
}

export async function isBwrapAvailable(): Promise<boolean> {
  return (await resolveBwrapPath()) !== null
}

/** Test-only: reset the cached availability check. */
export function resetBwrapCache(): void {
  cachedPath = undefined
}

export function buildLinuxSandboxCommand(req: SandboxBuildRequest, bwrapPath = "bwrap"): SandboxCommand {
  const home = homedir()
  const tmp = tmpdir()

  const args: string[] = ["--die-with-parent", "--unshare-pid", "--proc", "/proc", "--dev", "/dev"]

  for (const root of READONLY_ROOTS) {
    if (existsSync(root)) args.push("--ro-bind", root, root)
  }

  // Read-only $HOME first, then re-bind specific subpaths read-write so
  // the agent CLI's own config/cache dirs + the workspace stay writable
  // while the rest of $HOME (ssh keys, cloud credential caches, etc.)
  // stays read-only.
  if (existsSync(home)) args.push("--ro-bind", home, home)

  const writablePaths = [
    req.workspacePath,
    tmp,
    `${home}/.claude`,
    `${home}/.codex`,
    `${home}/.gemini`,
    `${home}/.cache`,
    `${home}/.npm`,
    `${home}/.bun`,
    `${home}/.config`,
  ]
  for (const p of writablePaths) {
    args.push("--bind-try", p, p)
  }

  args.push("--chdir", req.workspacePath)
  args.push("--")
  args.push(req.command, ...req.args)

  return { command: bwrapPath, args }
}
