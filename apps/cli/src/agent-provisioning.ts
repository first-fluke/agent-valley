import { type ChildProcess, spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { buildAgentEnv } from "@agent-valley/core/sessions/base-session"
import { resolveBinaryPath } from "@agent-valley/core/sessions/sandbox-binary"
import { type AgentAvailability, discoverAgents, supportsNativeLoginCommand } from "./agent-discovery"
import type { AgentType } from "./doctor-checks"

interface AgentProvisioningPlan {
  label: string
  documentation: string
  npmPackage?: string
  installerUrl?: string
  loginArgs: readonly string[]
  loginInstructions: string
}

/** Fixed commands from vendor installation/auth documentation; model/user text never enters this plan. */
export const AGENT_PROVISIONING: Readonly<Record<AgentType, AgentProvisioningPlan>> = {
  claude: {
    label: "Claude Code",
    documentation: "https://code.claude.com/docs/en/setup",
    npmPackage: "@anthropic-ai/claude-code",
    loginArgs: ["auth", "login"],
    loginInstructions: "Complete Claude's browser sign-in, then return to this wizard.",
  },
  codex: {
    label: "Codex",
    documentation: "https://developers.openai.com/codex/cli/reference/",
    npmPackage: "@openai/codex",
    loginArgs: ["login"],
    loginInstructions: "Complete Codex's browser sign-in, then return to this wizard.",
  },
  antigravity: {
    label: "Antigravity",
    documentation: "https://www.antigravity.google/docs/cli/install/",
    installerUrl: "https://antigravity.google/cli/install.sh",
    loginArgs: [],
    loginInstructions:
      "Complete the first-launch browser sign-in in agy, then exit the CLI. Authentication may require manual verification.",
  },
  cursor: {
    label: "Cursor Agent",
    documentation: "https://docs.cursor.com/en/cli/installation",
    installerUrl: "https://cursor.com/install",
    loginArgs: ["login"],
    loginInstructions: "Complete Cursor's browser sign-in, then return to this wizard.",
  },
  grok: {
    label: "Grok Build",
    documentation: "https://docs.x.ai/build/overview",
    npmPackage: "@xai-official/grok",
    loginArgs: ["login"],
    loginInstructions:
      "Complete Grok's browser sign-in. If native authentication cannot be inspected, recheck or configure it later.",
  },
  kimi: {
    label: "Kimi Code",
    documentation: "https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started",
    npmPackage: "@moonshot-ai/kimi-code",
    loginArgs: [],
    loginInstructions:
      "In Kimi, enter /login and complete OAuth or API-key setup. Then enter /exit to return to this wizard.",
  },
  opencode: {
    label: "OpenCode",
    documentation: "https://opencode.ai/docs/cli/",
    npmPackage: "opencode-ai",
    loginArgs: ["auth", "login"],
    loginInstructions: "Choose and authenticate an OpenCode provider, then return to this wizard.",
  },
}

export interface TerminalCommand {
  command: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
  cwd?: string
}

export interface TerminalCommandResult {
  success: boolean
  failure?: "failed" | "timed_out"
}

export interface ProvisioningDeps {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  resolveBinary: (name: string) => string | null
  discover: () => Promise<AgentAvailability[]>
  runCommand: (command: TerminalCommand) => Promise<TerminalCommandResult>
  supportsLoginCommand: (agent: AgentType, path: string, env: NodeJS.ProcessEnv) => Promise<boolean>
  makeTempDir: () => string
  removeTempDir: (path: string) => void
}

export interface ProvisioningResult {
  success: boolean
  message: string
}

/** Interactive output goes directly to the terminal; credentials/login codes are never captured. */
export function runTerminalCommand(
  request: TerminalCommand,
  spawnCommand: typeof spawn = spawn,
): Promise<TerminalCommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let timedOut = false
    const finish = (success: boolean) => {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      resolve(success ? { success: true } : { success: false, failure: timedOut ? "timed_out" : "failed" })
    }
    try {
      child = spawnCommand(request.command, [...request.args], {
        stdio: "inherit",
        env: request.env,
        shell: false,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      })
      child.once("error", () => finish(false))
      child.once("close", (code) => finish(!timedOut && code === 0))
      timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
        forceKill = setTimeout(() => {
          child.kill("SIGKILL")
          finish(false)
        }, 5_000)
      }, request.timeoutMs)
    } catch {
      finish(false)
    }
  })
}

function defaults(): ProvisioningDeps {
  return {
    platform: process.platform,
    home: homedir(),
    env: process.env,
    resolveBinary: resolveBinaryPath,
    discover: discoverAgents,
    runCommand: runTerminalCommand,
    supportsLoginCommand: (agent, path, env) => supportsNativeLoginCommand(agent, path, { env }),
    makeTempDir: () => mkdtempSync(join(tmpdir(), "av-agent-install-")),
    removeTempDir: (path) => rmSync(path, { recursive: true, force: true }),
  }
}

export async function inspectChiefAgent(
  agent: AgentType,
  overrides: Partial<ProvisioningDeps> = {},
): Promise<AgentAvailability> {
  const deps = { ...defaults(), ...overrides }
  const result = (await deps.discover()).find((entry) => entry.agentType === agent)
  return (
    result ?? {
      agentType: agent,
      readiness: "unknown",
      reason: "Chief Director CLI readiness could not be checked. Recheck or configure it later.",
    }
  )
}

function commandFailure(action: string, result: TerminalCommandResult, documentation: string): ProvisioningResult {
  return {
    success: false,
    message: `${action} ${result.failure === "timed_out" ? "timed out" : "did not complete"}. Retry or follow ${documentation}.`,
  }
}

type InstallerDeps = Pick<ProvisioningDeps, "env" | "resolveBinary" | "runCommand" | "makeTempDir" | "removeTempDir">

/** Execute only a caller-selected official HTTPS installer; argv and output remain native. */
export async function runOfficialInstaller(
  installerUrl: string,
  deps: InstallerDeps,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<TerminalCommandResult & { stage?: "prerequisites" | "download" | "installation" }> {
  const curl = deps.resolveBinary("curl")
  const bash = deps.resolveBinary("bash")
  if (!curl || !bash || !installerUrl.startsWith("https://"))
    return { success: false, failure: "failed", stage: "prerequisites" }
  let directory: string | undefined
  try {
    directory = deps.makeTempDir()
    const scriptPath = join(directory, "install.sh")
    const request = { env: options.env ?? deps.env, ...(options.cwd ? { cwd: options.cwd } : {}) }
    const download = await deps.runCommand({
      command: curl,
      args: [
        "--fail",
        "--location",
        "--silent",
        "--show-error",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--connect-timeout",
        "15",
        "--max-time",
        "120",
        "--max-filesize",
        "1048576",
        "--output",
        scriptPath,
        installerUrl,
      ],
      ...request,
      timeoutMs: 125_000,
    })
    if (!download.success) return { ...download, stage: "download" }
    const install = await deps.runCommand({ command: bash, args: [scriptPath], ...request, timeoutMs: 300_000 })
    return install.success ? install : { ...install, stage: "installation" }
  } finally {
    if (directory) {
      try {
        deps.removeTempDir(directory)
      } catch {
        // Temporary cleanup does not establish successful installation.
      }
    }
  }
}

export async function installChiefAgent(
  agent: AgentType,
  overrides: Partial<ProvisioningDeps> = {},
): Promise<ProvisioningResult> {
  const deps = { ...defaults(), ...overrides }
  const plan = AGENT_PROVISIONING[agent]
  try {
    if (plan.npmPackage) {
      const npm = deps.resolveBinary("npm")
      if (!npm) return { success: false, message: `Install Node.js 26 with npm, then retry. ${plan.documentation}` }
      const result = await deps.runCommand({
        command: npm,
        args: ["install", "--global", plan.npmPackage],
        env: deps.env,
        timeoutMs: 300_000,
      })
      return result.success
        ? { success: true, message: "Installation finished; checking the CLI next." }
        : commandFailure("Installation", result, plan.documentation)
    }
    if (deps.platform === "win32") {
      return {
        success: false,
        message: `Use the vendor's Windows or WSL installer, then choose Recheck. ${plan.documentation}`,
      }
    }
    const curl = deps.resolveBinary("curl")
    const bash = deps.resolveBinary("bash")
    if (!curl || !bash || !plan.installerUrl) {
      return {
        success: false,
        message: `Install curl and bash or follow the vendor's installer, then choose Recheck. ${plan.documentation}`,
      }
    }
    const install = await runOfficialInstaller(plan.installerUrl, deps)
    if (!install.success)
      return commandFailure(
        install.stage === "download" ? "Installer download" : "Installation",
        install,
        plan.documentation,
      )
    // Official native installers use ~/.local/bin; make it available to this wizard and subsequent orders.
    const localBin = join(deps.home, ".local", "bin")
    const pathParts = (deps.env.PATH ?? "").split(delimiter)
    if (!pathParts.includes(localBin)) deps.env.PATH = [localBin, ...pathParts.filter(Boolean)].join(delimiter)
    return { success: true, message: "Installation finished; checking the CLI next." }
  } catch {
    return { success: false, message: `Installation did not complete. Retry or follow ${plan.documentation}.` }
  }
}

export async function loginChiefAgent(
  agent: AgentType,
  overrides: Partial<ProvisioningDeps> = {},
): Promise<ProvisioningResult> {
  const deps = { ...defaults(), ...overrides }
  const plan = AGENT_PROVISIONING[agent]
  try {
    const state = await inspectChiefAgent(agent, deps)
    if (!state.binaryPath || state.readiness === "unavailable") {
      return { success: false, message: `Install ${plan.label} first, then retry login. ${plan.documentation}` }
    }
    if (plan.loginArgs.length > 0 && !(await deps.supportsLoginCommand(agent, state.binaryPath, deps.env))) {
      return {
        success: false,
        message: `This CLI version does not advertise its login command. Update it or follow ${plan.documentation}, then choose Recheck.`,
      }
    }
    const result = await deps.runCommand({
      command: state.binaryPath,
      args: plan.loginArgs,
      env: buildAgentEnv(agent, {}, deps.env),
      timeoutMs: 900_000,
    })
    return result.success
      ? { success: true, message: "Login command finished; authentication will be checked again." }
      : commandFailure("Login", result, plan.documentation)
  } catch {
    return { success: false, message: `Login did not complete. Retry or follow ${plan.documentation}.` }
  }
}
