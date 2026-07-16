/**
 * sandbox-darwin.ts — Seatbelt (`sandbox-exec`) command construction for macOS.
 *
 * Confines the wrapped process to:
 *   - Broad filesystem READ (toolchains legitimately need to read most of
 *     the host — language runtimes, global package caches, system
 *     libraries). This matches the ask in the sandboxing task: writes are
 *     confined, reads are not.
 *   - Filesystem WRITE limited to the workspace directory + a curated set
 *     of per-agent-CLI cache/config directories under $HOME (so the CLI
 *     itself keeps working) + the OS tmp dir.
 *   - Outbound network restricted to HTTP/HTTPS ports, plus local DNS
 *     resolution and local unix-domain sockets (ssh-agent and similar —
 *     these never leave the host).
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

import { homedir, tmpdir } from "node:os"
import { resolveBinaryPath } from "./sandbox-binary"
import type { SandboxBuildRequest, SandboxCommand } from "./sandbox-types"

const SANDBOX_EXEC_CANDIDATES = ["/usr/bin/sandbox-exec"]

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
): SandboxCommand {
  const profile = buildSeatbeltProfile(req)
  return {
    command: sandboxExecPath,
    args: ["-p", profile, req.command, ...req.args],
  }
}

function buildSeatbeltProfile(req: SandboxBuildRequest): string {
  const home = homedir()
  const tmp = tmpdir()

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

  const writeRules = writablePaths.map((p) => `(allow file-write* (subpath ${seatbeltString(p)}))`).join("\n")

  const deviceWriteRules = ["/dev/null", "/dev/zero", "/dev/tty", "/dev/ptmx"]
    .map((p) => `(allow file-write-data (literal ${seatbeltString(p)}))`)
    .join("\n")

  return `(version 1)
(deny default)

; Process operations — required for the agent CLI and its child tools
; (git, npm/bun, ripgrep, language servers, etc.) to function normally.
; Seatbelt profiles propagate to child processes automatically.
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)
(allow mach-lookup)
(allow system-socket)
(allow iokit-open)

; Filesystem — broad read, write confined to the workspace + curated
; per-agent-CLI cache/config dirs + OS tmp dir.
(allow file-read*)
(deny file-write*)
${writeRules}
${deviceWriteRules}

; Network — outbound denied by default. Local DNS + unix-domain sockets
; (ssh-agent, etc.) are allowed since they never cross the host boundary.
; Remote TCP is port-scoped to HTTP/HTTPS only (see module docstring for
; why per-domain scoping is not possible via sandbox-exec on this OS).
(deny network-outbound)
(allow network-outbound (remote unix-socket))
(allow mach-lookup (global-name "com.apple.mDNSResponder"))
(allow network-outbound (remote udp "*:53"))
(allow network-outbound (remote tcp "*:443"))
(allow network-outbound (remote tcp "*:80"))
`
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
