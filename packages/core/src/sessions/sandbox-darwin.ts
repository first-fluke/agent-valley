/**
 * sandbox-darwin.ts — Seatbelt (`sandbox-exec`) command construction for macOS.
 *
 * Confines the wrapped process to:
 *   - Broad filesystem READ (toolchains legitimately need to read most of
 *     the host — language runtimes, global package caches, system
 *     libraries), MINUS an explicit denylist of paths that hold
 *     credentials (see "Credential denylist" below). This matches the ask
 *     in the sandboxing task: writes are confined, reads are not — with
 *     the narrow exception of secrets a prompt-injected issue body could
 *     otherwise exfiltrate.
 *   - Filesystem WRITE limited to the workspace, active agent CLI home,
 *     shared tool caches, the OS tmp dir and the shared system tmp dirs
 *     (`/tmp`, `/private/tmp`, `/var/tmp`, `/private/var/tmp`). Toolchains
 *     create fixed scratch paths there (`/private/tmp/arc-uid-501` for
 *     Cargo, npm/bun caches, shell helpers) regardless of `TMPDIR`, so
 *     denying them fails otherwise healthy actor commands with EPERM.
 *   - Pseudo-terminal allocation (`pseudo-tty`, the `/dev/ptmx` ioctl and
 *     write/ioctl on the `/dev/ttysNNN` slave devices), so an actor CLI or
 *     review shell can open a pty instead of failing at `grantpt` with
 *     EPERM or "out of pty devices". Verified on macOS 26: the master
 *     ioctl alone still fails; the slave device grant is what makes
 *     `openpty` succeed.
 *   - Outbound network restricted to HTTP/HTTPS ports, plus local DNS
 *     resolution and local unix-domain sockets (ssh-agent and similar —
 *     these never leave the host).
 *   - TCP listeners (bind/inbound, plus loopback outbound) for opencode's CLI
 *     session server and for workspace tests that bind 127.0.0.1. Seatbelt's
 *     "localhost" address filter accepts every local bind address (verified on
 *     macOS 26: 0.0.0.0 and LAN addresses pass too), so the real limit is the
 *     outbound rule set, not the listener address.
 *   - Named Unix-domain listeners limited to the workspace, the OS tmp
 *     directory and the shared system tmp dirs; other local socket paths
 *     stay denied.
 *
 * Credential denylist (closes a HIGH-severity secret-exfiltration gap —
 * see docs/harness/SAFETY.md § 2 residual gaps and the sandbox result
 * doc): the broad `(allow file-read*)` below is followed by explicit
 * `(deny file-read* ...)` rules for `~/.config/agent-valley` (holds
 * LINEAR_API_KEY + other orchestrator secrets in settings.yaml), the
 * relay's `~/.agent-valley` credentials, inactive agent vendor homes, the
 * project's `av.yaml` (team webhook secret, Linear team id/uuid —
 * resolved best-effort from the orchestrator's cwd, which is chdir'd to
 * the project root at startup by apps/dashboard/src/lib/bootstrap.ts),
 * and `~/.ssh` + `~/.git-credentials` (git auth material the sandboxed
 * agent doesn't need — SSH auth for git push/pull goes through the
 * already-allowed ssh-agent unix-domain socket instead of reading private
 * key files directly). Seatbelt profiles are evaluated last-match-wins,
 * so placing these `(deny ...)` rules AFTER `(allow file-read*)` in the
 * generated profile text overrides it for exactly these paths. This does
 * NOT close every credential-exposure path — the active CLI must read its
 * own credentials, and cloud CLI credential caches
 * (e.g. `~/.aws`, `~/.config/gcloud`) and other tools' dotfiles under
 * `$HOME` remain readable; see the residual-gap note in SAFETY.md.
 *
 * GAP (documented, verified empirically — not a silent shortfall): the
 * original design intent was to scope `(remote tcp ...)` rules to the
 * caller-supplied domain allowlist by literal hostname. On current macOS
 * (verified on 26.5.2's `sandbox-exec`), the profile compiler rejects any
 * literal hostname or IP address in a `(remote tcp "...")` clause with
 * `sandbox-exec: host must be * or localhost in network address` — the
 * grammar only accepts `*` (any host) or `localhost`. Domain-scoped
 * network egress filtering is therefore NOT achievable via `sandbox-exec`
 * profile syntax on this platform; attempting it crashes the sandboxed
 * process outright (exit 65) instead of degrading gracefully. This
 * module falls back to port-scoped filtering instead: outbound TCP is
 * allowed only on 443/80 (any host), which blocks arbitrary raw-socket
 * exfiltration/backdoor ports but cannot stop HTTPS traffic to an
 * attacker-controlled domain. `sandbox-exec` itself is also marked
 * deprecated by Apple with no public replacement CLI. Real domain-scoped
 * enforcement would require a local forwarding proxy the agent CLI is
 * pointed at via HTTPS_PROXY (not implemented in this pass) — see
 * docs/harness/SAFETY.md and the sandbox result doc for the tracked gap.
 * The `networkAllowlist` field is still threaded through and returned on
 * the plan so a future proxy-based implementation has a config surface
 * to consume; it is not enforced by this module today.
 */

import { realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { PROJECT_CONFIG_FILENAME } from "../config/project-config-path"
import { agentHomeAccess } from "./sandbox-agent-paths"
import { resolveBinaryPath } from "./sandbox-binary"
import { linkedWorktreeGitPaths } from "./sandbox-git"
import type { SandboxBuildRequest, SandboxCommand } from "./sandbox-types"

const SANDBOX_EXEC_CANDIDATES = ["/usr/bin/sandbox-exec"]
/** Both the symlink and the resolved `/private` form: Seatbelt checks the real path. */
const SHARED_TMP_PATHS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"]

let cachedPath: string | null | undefined

/** Resolve the sandbox-exec binary path, or `null` if unavailable. Cached after first call. */
export async function resolveSandboxExecPath(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath
  cachedPath = resolveBinaryPath("sandbox-exec", SANDBOX_EXEC_CANDIDATES)
  return cachedPath
}

export async function isSandboxExecAvailable(): Promise<boolean> {
  return (await resolveSandboxExecPath()) !== null
}

/** Test-only: reset the cached availability check. */
export function resetSandboxExecCache(): void {
  cachedPath = undefined
}

export function buildDarwinSandboxCommand(
  req: SandboxBuildRequest,
  sandboxExecPath = "/usr/bin/sandbox-exec",
  home = homedir(),
): SandboxCommand {
  const profile = buildSeatbeltProfile(req, home)
  return {
    command: sandboxExecPath,
    args: ["-p", profile, req.command, ...req.args],
  }
}

function buildSeatbeltProfile(req: SandboxBuildRequest, home: string): string {
  const workspacePaths = pathAliases(req.workspacePath)
  const tmpPaths = pathAliases(tmpdir())
  const git = linkedWorktreeGitPaths(req.workspacePath)
  const agentPaths = agentHomeAccess(req.agentType, home, req.env)

  // On macOS, os.tmpdir() returns the `/var/folders/...` symlink path, but
  // Seatbelt resolves the real `/private/var/folders/...` path when a
  // process creates a NEW file there — a write-rule scoped only to the
  // `/var/folders/...` subpath silently denies those writes. Resolve the
  // real path and allow-list both forms so writes to the
  // sandboxed tmp workspace succeed regardless of which form the kernel
  // checks against. Keep unresolved paths when they do not exist yet.

  const writablePaths = [
    ...workspacePaths,
    ...tmpPaths,
    ...SHARED_TMP_PATHS,
    ...agentPaths.active,
    `${home}/.cache`,
    `${home}/.npm`,
    `${home}/.bun`,
  ]
  // NOTE: deliberately no blanket `${home}/.config` entry here — that
  // used to make `~/.config/agent-valley/settings.yaml` (and every other
  // tool's config under `~/.config`, e.g. `gh`, `gcloud`) writable by the
  // sandboxed process. The active CLI receives only its known paths.

  const writeRules = writablePaths.map((p) => `(allow file-write* (subpath ${seatbeltString(p)}))`).join("\n")
  // Nest the path filter inside local unix-socket: sibling filters are ORed
  // by Seatbelt and would allow Unix listeners outside these directories.
  const unixListenerRules = [...new Set([...workspacePaths, ...tmpPaths, ...SHARED_TMP_PATHS])]
    .flatMap((path) =>
      ["network-bind", "network-inbound"].map(
        (operation) => `(allow ${operation} (local unix-socket (subpath ${seatbeltString(path)})))`,
      ),
    )
    .join("\n")
  const gitWriteRules = git
    ? [git.gitDir, git.objectsDir]
        .map((p) => `(allow file-write* (subpath ${seatbeltString(p)}))`)
        .concat(
          [
            git.branchRef,
            `${git.branchRef}.lock`,
            git.branchReflog,
            `${git.branchReflog}.lock`,
            `${git.commonDir}/packed-refs.lock`,
          ].map((p) => `(allow file-write* (literal ${seatbeltString(p)}))`),
        )
        .join("\n")
    : ""

  const deviceWriteRules = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/ptmx"]
    .map((p) => `(allow file-write-data (literal ${seatbeltString(p)}))`)
    .join("\n")

  // See the module docstring "Credential denylist" section for why these
  // exact paths are carved out of the broad read allowance below.
  const denyReadSubpaths = [
    `${home}/.config/agent-valley`,
    `${home}/.agent-valley`,
    `${home}/.ssh`,
    ...agentPaths.inactive,
  ]
  const denyReadLiterals = [
    `${home}/.git-credentials`,
    ...new Set(
      [process.cwd(), req.workspacePath].flatMap((root) =>
        pathAliases(root).flatMap((path) => pathAliases(join(path, PROJECT_CONFIG_FILENAME))),
      ),
    ),
  ]
  const denyReadRules = [
    ...denyReadSubpaths.map((p) => `(deny file-read* (subpath ${seatbeltString(p)}))`),
    ...denyReadLiterals.map((p) => `(deny file-read* (literal ${seatbeltString(p)}))`),
  ].join("\n")
  // Apply write denies after all workspace/Git grants. A workspace nested
  // under a credential directory must not re-enable access to that directory.
  const denyWriteRules = [
    ...denyReadSubpaths.map((p) => `(deny file-write* (subpath ${seatbeltString(p)}))`),
    ...denyReadLiterals.map((p) => `(deny file-write* (literal ${seatbeltString(p)}))`),
    ...(git
      ? ["info", "pack"].map((name) => `(deny file-write* (subpath ${seatbeltString(join(git.objectsDir, name))}))`)
      : []),
  ].join("\n")

  return `(version 1)
(deny default)

; Process operations — required for the agent CLI and its child tools
; (git, npm/bun, ripgrep, language servers, etc.) to function normally.
; Seatbelt profiles propagate to child processes automatically.
(allow process-fork)
(allow process-exec)
; Actor CLIs and their child shells allocate a pseudo-terminal; without this
; grantpt/openpt fail with EPERM and the actor cannot start a shell at all.
(allow pseudo-tty)
(allow signal (target self))
; Tool cancellation must reach grandchildren; target children covers only direct children.
(allow signal (target same-sandbox))
(allow sysctl-read)
(allow mach-lookup)
${req.agentType === "codex" ? '(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))' : ""}
(allow system-socket)
(allow iokit-open)

; Filesystem — broad read (minus the credential denylist below), write
; confined to the workspace + active agent CLI home + shared caches +
; OS tmp dir + the shared system tmp dirs toolchains hardcode.
(allow file-read*)
${denyReadRules}
(deny file-write*)
${writeRules}
${gitWriteRules}
${deviceWriteRules}
; Pty allocation ioctls the master device, then opens and configures the
; slave (/dev/ttysNNN). Without the slave grant openpty fails with
; "out of pty devices" even though pseudo-tty and the ptmx ioctl are allowed.
(allow file-ioctl (literal "/dev/ptmx"))
(allow file-write* (regex #"^/dev/ttys[0-9]+$"))
(allow file-ioctl (regex #"^/dev/ttys[0-9]+$"))
${denyWriteRules}

; Network — outbound denied by default. Local DNS + unix-domain sockets
; (ssh-agent, etc.) are allowed since they never cross the host boundary.
; Remote TCP is port-scoped to HTTP/HTTPS only (see module docstring for
; why per-domain scoping is not possible via sandbox-exec on this OS).
(deny network-outbound)
(allow network-outbound (remote unix-socket))
; Local named Unix servers are needed by workspace IPC tests and resident tools.
; This does not permit TCP listeners or Unix binds in caches/vendor homes.
${unixListenerRules}
(allow mach-lookup (global-name "com.apple.mDNSResponder"))
(allow network-outbound (remote udp "*:53"))
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote tcp "*:80"))
; TCP listeners: opencode serves its CLI session over a localhost HTTP server, and
; workspace test suites bind 127.0.0.1 listeners (daemon/IPC/non-contact tests). Seatbelt
; only accepts "*" or "localhost" here and "localhost" matches every local bind address,
; so outbound egress above is what keeps actors from reaching other hosts.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
`
}

function pathAliases(path: string): string[] {
  try {
    const canonical = realpathSync(path)
    return canonical === path ? [path] : [path, canonical]
  } catch {
    return [path]
  }
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
