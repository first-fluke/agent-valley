/**
 * doctor-checks.ts — Pure, injectable diagnostic checks backing `av doctor`.
 *
 * Every check takes an explicit `DoctorDeps` bag (filesystem, PATH
 * resolver, sandbox-availability probes, config loaders) so checks are
 * unit-testable without touching the real filesystem, PATH, or spawning
 * a real agent CLI. No console output lives here — that is doctor.ts's
 * job (Presentation layer). This file only computes structured results.
 *
 * Holds: shared types/deps, agent CLI install + auth checks, sandbox
 * check. Config/tunnel/webhook-secret checks + orchestration live in
 * `doctor-config-checks.ts` (kept in a separate file to stay under the
 * 500-line-per-file limit — see docs/architecture/CONSTRAINTS.md).
 *
 * Sandbox detection reuses `@agent-valley/core/sessions/sandbox-darwin`
 * / `sandbox-linux` (themselves built on `sandbox-binary.ts`'s portable
 * PATH scan) instead of re-implementing "is this binary installed"
 * logic.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { GlobalConfig, ProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { loadGlobalConfig, loadProjectConfig, resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import { resolveBinaryPath } from "@agent-valley/core/sessions/sandbox-binary"
import { isSandboxExecAvailable } from "@agent-valley/core/sessions/sandbox-darwin"
import { isBwrapAvailable } from "@agent-valley/core/sessions/sandbox-linux"

export type AgentType = "claude" | "codex" | "antigravity" | "cursor" | "grok" | "kimi" | "opencode"

export const AGENT_TYPES: AgentType[] = ["claude", "codex", "antigravity", "cursor", "grok", "kimi", "opencode"]

export type CheckStatus = "pass" | "fail" | "warn" | "unknown"

export interface CheckResult {
  /** Stable machine id, e.g. "config.project" — used by tests and callers. */
  id: string
  name: string
  status: CheckStatus
  message: string
  /** Actionable remediation. Present whenever status !== "pass". */
  fix?: string
  /** Whether a "fail" here should make `av doctor`'s exit code non-zero. */
  critical: boolean
}

// ── Dependency injection ────────────────────────────────────────────────────

export interface DoctorDeps {
  cwd: string
  home: string
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  existsSync: (path: string) => boolean
  readFileSync: (path: string) => string
  resolveBinary: (name: string, candidateAbsolutePaths?: string[]) => string | null
  isSandboxExecAvailable: () => Promise<boolean>
  isBwrapAvailable: () => Promise<boolean>
  resolveGlobalConfigPath: () => string
  loadGlobalConfig: (configPath?: string) => GlobalConfig | null
  loadProjectConfig: (projectRoot?: string) => ProjectConfig | null
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    cwd: process.cwd(),
    home: homedir(),
    platform: process.platform,
    env: process.env,
    existsSync,
    readFileSync: (p) => readFileSync(p, "utf-8"),
    resolveBinary: resolveBinaryPath,
    isSandboxExecAvailable,
    isBwrapAvailable,
    resolveGlobalConfigPath,
    loadGlobalConfig,
    loadProjectConfig,
  }
}

// ── Agent CLI metadata ───────────────────────────────────────────────────────

export const AGENT_BINARY: Record<AgentType, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
  cursor: "cursor-agent",
  grok: "grok",
  kimi: "kimi",
  opencode: "opencode",
}

export const AGENT_INSTALL_HINT: Record<AgentType, string> = {
  claude: "Install: npm install -g @anthropic-ai/claude-code (see https://claude.com/product/claude-code)",
  codex: "Install: npm install -g @openai/codex (see https://github.com/openai/codex)",
  antigravity: "Install: see Antigravity docs for the `agy` CLI (https://antigravity.google)",
  cursor: "Install: curl https://cursor.com/install -fsS | bash (see https://docs.cursor.com/cli)",
  grok: "Install: see xAI Grok CLI docs for the `grok` binary (https://docs.x.ai)",
  kimi: "Install: see Kimi CLI docs for the `kimi` binary (https://kimi.moonshot.cn)",
  opencode: "Install: curl -fsSL https://opencode.ai/install | bash (see https://opencode.ai/docs)",
}

export const AGENT_LOGIN_HINT: Record<AgentType, string> = {
  claude: "Run `claude` and complete the browser login prompt.",
  codex: "Run `codex login`.",
  antigravity: "Run `agy login` (see Antigravity docs).",
  cursor: "Run `cursor-agent login`.",
  grok: "Run `grok login` (see xAI docs).",
  kimi: "Run `kimi`, then `/login` to complete the device-code flow.",
  opencode: "Run `opencode auth login`.",
}

/**
 * Best-effort, cheap auth-state probe per agent CLI. Never spawns the CLI
 * or makes a real LLM call — only checks for the presence of the vendor's
 * own auth/config file. When that isn't a reliable enough signal (agy,
 * cursor), reports "unknown" instead of guessing.
 */
function probeAgentAuth(agent: AgentType, deps: DoctorDeps): { status: CheckStatus; message: string } {
  const { home, existsSync: exists, readFileSync: read } = deps

  switch (agent) {
    case "claude": {
      const p = join(home, ".claude")
      return exists(p) ? { status: "pass", message: `${p} present` } : { status: "fail", message: `${p} not found` }
    }
    case "codex": {
      const p = join(home, ".codex")
      return exists(p) ? { status: "pass", message: `${p} present` } : { status: "fail", message: `${p} not found` }
    }
    case "grok": {
      const p = join(home, ".grok", "config.toml")
      return exists(p) ? { status: "pass", message: `${p} present` } : { status: "fail", message: `${p} not found` }
    }
    case "kimi": {
      const p = join(home, ".kimi-code", "config.toml")
      if (!exists(p)) return { status: "fail", message: `${p} not found` }
      try {
        const content = read(p)
        return content.includes("default_model")
          ? { status: "pass", message: `${p} present with default_model set` }
          : { status: "warn", message: `${p} present but no default_model found` }
      } catch {
        return { status: "unknown", message: `${p} present but unreadable` }
      }
    }
    case "opencode": {
      const p = join(home, ".local", "share", "opencode", "auth.json")
      return exists(p) ? { status: "pass", message: `${p} present` } : { status: "fail", message: `${p} not found` }
    }
    case "antigravity":
    case "cursor":
      return { status: "unknown", message: "auth state can't be cheaply determined for this CLI" }
  }
}

export function checkAgentInstalled(agent: AgentType, deps: DoctorDeps, critical: boolean): CheckResult {
  const bin = AGENT_BINARY[agent]
  const resolved = deps.resolveBinary(bin)
  const base = { id: `agent.${agent}.installed`, name: `Agent CLI installed (${agent} → ${bin})` }
  if (resolved) {
    return { ...base, status: "pass", message: `Found at ${resolved}`, critical: false }
  }
  return {
    ...base,
    status: "fail",
    message: `\`${bin}\` not found on PATH`,
    fix: AGENT_INSTALL_HINT[agent],
    critical,
  }
}

export function checkAgentAuthenticated(agent: AgentType, deps: DoctorDeps): CheckResult {
  const { status, message } = probeAgentAuth(agent, deps)
  const base = { id: `agent.${agent}.auth`, name: `Agent CLI authenticated (${agent})`, critical: false }
  if (status === "unknown") {
    return { ...base, status, message: `unknown — run a test issue to confirm (${message})` }
  }
  if (status === "pass") return { ...base, status, message }
  return { ...base, status, message, fix: AGENT_LOGIN_HINT[agent] }
}

// ── Sandbox ──────────────────────────────────────────────────────────────────

export async function checkSandbox(deps: DoctorDeps): Promise<CheckResult> {
  if (deps.platform === "darwin") {
    const available = await deps.isSandboxExecAvailable()
    return available
      ? {
          id: "sandbox",
          name: "Sandbox binary (sandbox-exec)",
          status: "pass",
          message: "/usr/bin/sandbox-exec available",
          critical: false,
        }
      : {
          id: "sandbox",
          name: "Sandbox binary (sandbox-exec)",
          status: "fail",
          message: "sandbox-exec not found",
          fix: "sandbox-exec ships with macOS at /usr/bin/sandbox-exec. Verify with `which sandbox-exec` — this is unexpected on a stock macOS install.",
          critical: true,
        }
  }
  if (deps.platform === "linux") {
    const available = await deps.isBwrapAvailable()
    return available
      ? { id: "sandbox", name: "Sandbox binary (bwrap)", status: "pass", message: "bwrap available", critical: false }
      : {
          id: "sandbox",
          name: "Sandbox binary (bwrap)",
          status: "fail",
          message: "bwrap not found",
          fix:
            "Install bubblewrap: `apt-get install bubblewrap` (Debian/Ubuntu) or `dnf install bubblewrap` (Fedora). " +
            "The sandbox is fail-closed — agent spawns will be refused until bwrap is installed, or set " +
            "SYMPHONY_ALLOW_UNSANDBOXED=1 (NOT recommended — removes filesystem/network containment).",
          critical: true,
        }
  }
  return {
    id: "sandbox",
    name: "Sandbox binary",
    status: "fail",
    message: `Platform "${deps.platform}" has no supported OS sandbox (only darwin/sandbox-exec and linux/bwrap).`,
    fix: "Run on macOS or Linux, or set SYMPHONY_ALLOW_UNSANDBOXED=1 (NOT recommended).",
    critical: true,
  }
}
