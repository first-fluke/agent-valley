/**
 * sandbox-linux.ts — bubblewrap (`bwrap`) command construction for Linux.
 *
 * Confines the wrapped process to:
 *   - Read-only view of standard system roots (/usr, /bin, /sbin, /lib,
 *     /lib64, /etc, /opt, /var) plus a read-only view of $HOME, MINUS an
 *     explicit credential denylist masked out with a `--tmpfs`/`/dev/null`
 *     overlay (see "Credential denylist" below).
 *   - Read-write access to the workspace, active agent CLI home, and
 *     shared tool caches under $HOME (bound AFTER the
 *     read-only $HOME mount so they override it) + the OS tmp dir.
 *
 * Credential denylist (closes a HIGH-severity secret-exfiltration gap —
 * see docs/harness/SAFETY.md § 2 residual gaps and the sandbox result
 * doc): bubblewrap processes `--ro-bind`/`--tmpfs`/`--bind` mounts in
 * argv order, and a mount added later at the same (or a nested) path
 * shadows whatever an earlier mount put there. After the read-only
 * `$HOME` bind below, this module layers `--tmpfs` (for directories) and
 * `--ro-bind /dev/null` (for individual files — the standard "mask a
 * path" idiom bwrap/Docker both use) over:
 *   - `~/.config/agent-valley` — holds LINEAR_API_KEY + other
 *     orchestrator secrets in settings.yaml.
 *   - `~/.agent-valley` — relay credentials and local state.
 *   - inactive agent vendor homes — credentials unrelated to this CLI.
 *   - the project's `valley.yaml` — team webhook secret, Linear team
 *     id/uuid (only masked when it resolves under `$HOME`, i.e. is
 *     actually part of the mounted tree — see `maskCredentialPaths`).
 *   - `~/.ssh`, `~/.git-credentials` — git auth material the sandboxed
 *     agent doesn't need; SSH auth for git push/pull goes through the
 *     ssh-agent unix-domain socket (unaffected by filesystem
 *     confinement), not by reading private key files directly.
 *
 * Linux workspaces use isolated local clones: their Git index, refs,
 * objects, and lockfiles live inside the writable workspace. A linked
 * worktree is rejected because binding its shared ref directory writable
 * would also expose refs owned by other issues. The rest of `$HOME` stays
 * readable for toolchains, apart from the credential masks above. This
 * does NOT close every credential-exposure path — the active CLI must read
 * its own credentials, and cloud CLI
 * credential caches (e.g. `~/.aws`, `~/.config/gcloud`) and other tools'
 * dotfiles under `$HOME` remain readable; see the residual-gap note in
 * SAFETY.md.
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
import { join } from "node:path"
import { agentHomeAccess } from "./sandbox-agent-paths"
import { resolveBinaryPath } from "./sandbox-binary"
import { linkedWorktreeGitPaths } from "./sandbox-git"
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

export function buildLinuxSandboxCommand(
  req: SandboxBuildRequest,
  bwrapPath = "bwrap",
  home = homedir(),
): SandboxCommand {
  if (linkedWorktreeGitPaths(req.workspacePath)) {
    throw new Error(
      `sessions/sandbox: Linux cannot safely mount shared Git refs for linked worktree ${req.workspacePath}. ` +
        "Recreate this workspace with WorkspaceManager on Linux to use an isolated Git clone.",
    )
  }
  const tmp = tmpdir()
  const agentPaths = agentHomeAccess(req.agentType, home)

  const args: string[] = ["--die-with-parent", "--unshare-pid", "--proc", "/proc", "--dev", "/dev"]

  for (const root of READONLY_ROOTS) {
    if (existsSync(root)) args.push("--ro-bind", root, root)
  }

  // Read-only $HOME first, then re-bind specific subpaths read-write so
  // the agent CLI's own config/cache dirs + the workspace stay writable
  // while the rest of $HOME stays read-only.
  if (existsSync(home)) {
    args.push("--ro-bind", home, home)
  }

  const writablePaths = [req.workspacePath, tmp, ...agentPaths.active, `${home}/.cache`, `${home}/.npm`, `${home}/.bun`]
  // NOTE: deliberately no blanket `${home}/.config` entry here — see the
  // module docstring "Credential denylist" section. Agent CLIs this
  // project spawns get only their active vendor path.
  for (const p of writablePaths) {
    args.push("--bind-try", p, p)
  }

  // Masks come last so even a workspace nested under a protected directory
  // cannot expose host credentials through its later read-write bind.
  if (existsSync(home)) maskCredentialPaths(args, home, agentPaths.inactive)

  args.push("--chdir", req.workspacePath)
  args.push("--")
  args.push(req.command, ...req.args)

  return { command: bwrapPath, args }
}

/**
 * Append bwrap args that shadow credential-bearing paths out of the
 * already-mounted read-only `home` tree. Mutates `args` in place (called
 * once, right after the `--ro-bind home home` call it depends on).
 *
 * Directories are masked with `--tmpfs DEST` (an empty, unreadable
 * overlay — bwrap creates the mount point even if the underlying host
 * path doesn't exist, so this is safe to call unconditionally).
 * Individual files are masked with `--ro-bind /dev/null DEST` (the same
 * idiom Docker uses for masked paths) — `/dev/null` always exists on the
 * host, and bwrap creates the destination file node if it isn't already
 * present in the mounted tree.
 *
 * The project's `valley.yaml` is only masked when it resolves to a path
 * under `home` (i.e. is actually part of the tree mounted above) —
 * masking a destination whose parent directories were never bound would
 * make bwrap fail to construct the sandbox at all, since bwrap can only
 * create a bind destination inside a tree that already exists in the
 * mount namespace being built.
 */
function maskCredentialPaths(args: string[], home: string, inactiveAgentPaths: string[]): void {
  const maskDirs = [`${home}/.config/agent-valley`, `${home}/.agent-valley`, `${home}/.ssh`, ...inactiveAgentPaths]
  for (const dir of maskDirs) {
    args.push("--tmpfs", dir)
  }

  const maskFiles = [`${home}/.git-credentials`]
  const projectValleyYaml = join(process.cwd(), "valley.yaml")
  if (projectValleyYaml === home || projectValleyYaml.startsWith(`${home}/`)) {
    maskFiles.push(projectValleyYaml)
  }
  for (const file of maskFiles) {
    args.push("--ro-bind", "/dev/null", file)
  }
}
