/**
 * sandbox.ts — OS-level sandbox wrapper for spawned agent CLIs.
 *
 * Every session (claude/codex/gemini) must run its agent CLI
 * non-interactively — there is no TTY to answer permission prompts, so
 * each CLI is invoked with its own permission-bypass flag
 * (`--dangerously-skip-permissions`, `approvalPolicy: "never"`,
 * `--yolo`). That flag alone would give a prompt-injected issue body
 * full shell + filesystem + network access to the host running the
 * orchestrator.
 *
 * This module routes the actual process spawn through an OS sandbox so
 * containment comes from the kernel, not from trusting the agent CLI's
 * own approval logic:
 *   - macOS (darwin): Seatbelt via `sandbox-exec` — see sandbox-darwin.ts.
 *   - Linux: bubblewrap via `bwrap` — see sandbox-linux.ts (filesystem
 *     confinement only; network egress is NOT domain-restricted there,
 *     documented gap).
 *   - Any other platform, or the platform's sandbox binary missing: the
 *     spawn is refused (fail closed) by default. The bypass flags stay
 *     in the CLI's own argv either way (removing them would reintroduce
 *     an interactive prompt that hangs a non-interactive spawn) — what
 *     changes is whether the OS sandbox is there to contain them.
 *
 * Opt-in unsandboxed fallback: set `SYMPHONY_ALLOW_UNSANDBOXED=1` to run
 * without an OS sandbox when one isn't available on the host. This is
 * NOT the default — the default is fail-closed — and every unsandboxed
 * spawn logs a loud WARN naming exactly what is missing.
 */

import { logger } from "../observability/logger"
import { buildDarwinSandboxCommand, isSandboxExecAvailable, resolveSandboxExecPath } from "./sandbox-darwin"
import { buildLinuxSandboxCommand, isBwrapAvailable, resolveBwrapPath } from "./sandbox-linux"
import type { SandboxCommand } from "./sandbox-types"

export const DEFAULT_NETWORK_ALLOWLIST: readonly string[] = Object.freeze([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "registry.npmjs.org",
])

export const ALLOW_UNSANDBOXED_ENV_VAR = "SYMPHONY_ALLOW_UNSANDBOXED"
export const NETWORK_ALLOWLIST_ENV_VAR = "SYMPHONY_SANDBOX_NETWORK_ALLOWLIST"

export interface SandboxSpawnRequest {
  /** Agent type — "claude" | "codex" | "gemini" | custom, used for logs/errors only. */
  agentType: string
  /** Base binary to execute, e.g. "claude". */
  command: string
  /** Base argv for `command`, already including the CLI's non-interactive/bypass flags. */
  args: string[]
  /** Git worktree path the agent is allowed to write to. */
  workspacePath: string
}

export interface SandboxSpawnPlan extends SandboxCommand {
  sandboxed: boolean
  platform: NodeJS.Platform
  networkAllowlist: string[]
}

export interface PlanSandboxedSpawnDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /**
   * Override for "is the platform sandbox binary available". When
   * provided, this replaces the real `isSandboxExecAvailable` /
   * `isBwrapAvailable` checks for BOTH platforms — used by tests so they
   * never depend on the host actually having sandbox-exec/bwrap
   * installed.
   */
  checkAvailable?: () => Promise<boolean>
}

/** Resolve the effective network egress allowlist: defaults + any operator-configured extras. */
export function resolveNetworkAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = env[NETWORK_ALLOWLIST_ENV_VAR]
  if (!extra) return [...DEFAULT_NETWORK_ALLOWLIST]
  const custom = extra
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)
  return [...new Set([...DEFAULT_NETWORK_ALLOWLIST, ...custom])]
}

/** Whether the operator has explicitly opted into running without an OS sandbox. */
export function isUnsandboxedFallbackAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ALLOW_UNSANDBOXED_ENV_VAR] === "1"
}

/**
 * Produce the actual command/argv to spawn for `req`, wrapped in an OS
 * sandbox when one is available on the current platform.
 *
 * Throws (fail closed) when no sandbox is available and
 * SYMPHONY_ALLOW_UNSANDBOXED=1 is not set. Sessions should let this
 * propagate as a CRASH-classified agent error rather than swallowing it.
 */
export async function planSandboxedSpawn(
  req: SandboxSpawnRequest,
  deps: PlanSandboxedSpawnDeps = {},
): Promise<SandboxSpawnPlan> {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const networkAllowlist = resolveNetworkAllowlist(env)
  const buildReq = { ...req, networkAllowlist }

  if (platform === "darwin") {
    const available = deps.checkAvailable ? await deps.checkAvailable() : await isSandboxExecAvailable()
    if (available) {
      const sandboxExecPath = deps.checkAvailable
        ? "/usr/bin/sandbox-exec"
        : ((await resolveSandboxExecPath()) ?? "/usr/bin/sandbox-exec")
      const wrapped = buildDarwinSandboxCommand(buildReq, sandboxExecPath)
      return { ...wrapped, sandboxed: true, platform, networkAllowlist }
    }
    return fallbackOrThrow(
      req,
      platform,
      env,
      networkAllowlist,
      "sandbox-exec",
      "sandbox-exec ships with macOS at /usr/bin/sandbox-exec. If missing, verify with `which sandbox-exec` — this is not expected on a stock macOS install.",
    )
  }

  if (platform === "linux") {
    const available = deps.checkAvailable ? await deps.checkAvailable() : await isBwrapAvailable()
    if (available) {
      const bwrapPath = deps.checkAvailable ? "bwrap" : ((await resolveBwrapPath()) ?? "bwrap")
      const wrapped = buildLinuxSandboxCommand(buildReq, bwrapPath)
      logger.warn(
        "sessions.sandbox",
        "Linux sandbox (bwrap) enforces filesystem confinement only — network egress is NOT domain-restricted on this platform. See docs/harness/SAFETY.md for the tracked gap.",
        { agentType: req.agentType, workspacePath: req.workspacePath },
      )
      return { ...wrapped, sandboxed: true, platform, networkAllowlist }
    }
    return fallbackOrThrow(
      req,
      platform,
      env,
      networkAllowlist,
      "bwrap",
      "Install bubblewrap: `apt-get install bubblewrap` (Debian/Ubuntu), `dnf install bubblewrap` (Fedora), or the equivalent for your distro.",
    )
  }

  return fallbackOrThrow(
    req,
    platform,
    env,
    networkAllowlist,
    "(none)",
    `Platform "${platform}" has no supported OS sandbox in this implementation (only darwin/sandbox-exec and linux/bwrap are handled).`,
  )
}

function fallbackOrThrow(
  req: SandboxSpawnRequest,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  networkAllowlist: string[],
  missingBinary: string,
  installHint: string,
): SandboxSpawnPlan {
  if (!isUnsandboxedFallbackAllowed(env)) {
    throw new Error(
      `sessions/sandbox: no OS sandbox available for agent "${req.agentType}" on platform "${platform}" (missing: ${missingBinary}).\n` +
        `  Fix: ${installHint}\n` +
        "  Or explicitly opt into the unsandboxed fallback (NOT RECOMMENDED — the agent CLI's own\n" +
        "  permission-bypass flag then has full host filesystem + network access to a\n" +
        "  prompt-injected issue body):\n" +
        `    ${ALLOW_UNSANDBOXED_ENV_VAR}=1\n` +
        "  Location: set in the orchestrator process environment (shell/.env), not in valley.yaml.",
    )
  }

  logger.warn(
    "sessions.sandbox",
    `Running agent "${req.agentType}" WITHOUT an OS sandbox — ${ALLOW_UNSANDBOXED_ENV_VAR}=1 is set and no sandbox binary (${missingBinary}) was found on platform "${platform}". The agent CLI's permission-bypass flag now grants full host filesystem + network access to a prompt-injected issue body.`,
    { agentType: req.agentType, platform, workspacePath: req.workspacePath },
  )

  return { command: req.command, args: req.args, sandboxed: false, platform, networkAllowlist }
}
