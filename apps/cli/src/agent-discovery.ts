import { execFile } from "node:child_process"
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import { buildAgentEnv, getAgentAuthEnvKeys } from "@agent-valley/core/sessions/base-session"
import { resolveBinaryPath } from "@agent-valley/core/sessions/sandbox-binary"
import { AGENT_BINARY, AGENT_INSTALL_HINT, AGENT_LOGIN_HINT, AGENT_TYPES, type AgentType } from "./doctor-checks"

export type AgentReadiness = "ready" | "unknown" | "unavailable" | "unauthenticated"

export interface AgentAvailability {
  agentType: AgentType
  binaryPath?: string
  readiness: AgentReadiness
  reason: string
}

export interface AuthProbeResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export interface AuthProbeOptions {
  env: NodeJS.ProcessEnv
  timeoutMs: number
  maxOutputBytes: number
  signal: AbortSignal
}

export interface DiscoveryDeps {
  home: string
  env: NodeJS.ProcessEnv
  now: () => number
  resolveBinary: (name: string) => string | null
  isExecutableFile: (path: string) => boolean
  fileInfo: (path: string) => { isFile: boolean; size: number } | null
  readFile: (path: string) => string
  parseToml: (content: string) => unknown
  probe: (path: string, args: readonly string[], options: AuthProbeOptions) => Promise<AuthProbeResult>
}

const PROBE_TIMEOUT_MS = 5_000
const MAX_OUTPUT_BYTES = 16_384
const MAX_AUTH_FILE_BYTES = 1_048_576
type AuthEvidence = Pick<AgentAvailability, "readiness" | "reason">
type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function defaultProbe(path: string, args: readonly string[], options: AuthProbeOptions): Promise<AuthProbeResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      path,
      [...args],
      {
        encoding: "utf8",
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error && (typeof error.code !== "number" || error.killed)) {
          reject(new Error("Native authentication probe could not complete"))
        } else {
          resolve({ exitCode: error ? (error.code as number) : 0, stdout, stderr })
        }
      },
    )
    child.stdin?.end()
  })
}

function defaultDeps(): DiscoveryDeps {
  return {
    home: homedir(),
    env: process.env,
    now: Date.now,
    resolveBinary: resolveBinaryPath,
    isExecutableFile: (path) => {
      try {
        accessSync(path, constants.X_OK)
        return statSync(path).isFile()
      } catch {
        return false
      }
    },
    fileInfo: (path) => {
      try {
        const stat = statSync(path)
        return { isFile: stat.isFile(), size: stat.size }
      } catch (error) {
        if (record(error).code === "ENOENT") return null
        throw new Error("Authentication state cannot be inspected")
      }
    },
    readFile: (path) => readFileSync(path, "utf8"),
    parseToml: (content) => Bun.TOML.parse(content),
    probe: defaultProbe,
  }
}

function unknown(agent: AgentType, detail: string): AuthEvidence {
  return {
    readiness: "unknown",
    reason: `${detail}. ${AGENT_LOGIN_HINT[agent]} Update the CLI and retry auto-selection.`,
  }
}

function missing(agent: AgentType, detail = "No usable authentication credentials found"): AuthEvidence {
  return { readiness: "unauthenticated", reason: `${detail}. ${AGENT_LOGIN_HINT[agent]}` }
}

function readState(path: string, deps: DiscoveryDeps, parse: (content: string) => unknown = JSON.parse): unknown {
  const info = deps.fileInfo(path)
  if (info === null) return null
  if (!info.isFile || info.size > MAX_AUTH_FILE_BYTES) throw new Error("Unsupported authentication file")
  const content = deps.readFile(path)
  if (Buffer.byteLength(content) > MAX_AUTH_FILE_BYTES) throw new Error("Authentication file too large")
  return parse(content)
}

function expired(token: string, expiresAt: unknown, now: number, unit = 1): boolean {
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt * unit <= now) return true
  }
  const payload = token.split(".")[1]
  if (payload) {
    try {
      const exp = record(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).exp
      if (exp !== undefined && (typeof exp !== "number" || exp * 1_000 <= now)) return true
    } catch {
      // Opaque native tokens are valid credential shapes too.
    }
  }
  return false
}

function kimiAuth(deps: DiscoveryDeps): AuthEvidence {
  // Plain KIMI_API_KEY exports are not consumed by Kimi's native provider configuration.
  // https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars
  const home = nonempty(deps.env.KIMI_CODE_HOME) ? deps.env.KIMI_CODE_HOME : join(deps.home, ".kimi-code")
  const config = record(readState(join(home, "config.toml"), deps, deps.parseToml))
  const model = record(record(config.models)[String(config.default_model ?? "")])
  const provider = record(record(config.providers)[String(model.provider ?? "")])
  if (nonempty(model.model) && nonempty(provider.type) && nonempty(provider.base_url)) {
    if (nonempty(provider.api_key)) return { readiness: "ready", reason: "Configured Kimi provider credentials found" }
    const providerEnv = record(provider.env)
    if (
      ["KIMI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY"].some((key) =>
        nonempty(providerEnv[key]),
      )
    ) {
      return { readiness: "ready", reason: "Configured Kimi provider credentials found" }
    }
    const oauth = record(provider.oauth)
    if (nonempty(oauth.key) && (oauth.storage === "file" || oauth.storage === "keyring")) {
      const name = oauth.key.split("/").at(-1)
      if (name && /^[\w-]+$/.test(name)) {
        const token = record(readState(join(home, "credentials", `${name}.json`), deps))
        if (
          nonempty(token.access_token) &&
          nonempty(token.refresh_token) &&
          typeof token.expires_at === "number" &&
          !expired(token.access_token, token.expires_at, deps.now(), 1_000)
        ) {
          return { readiness: "ready", reason: "Kimi native OAuth credentials found" }
        }
        if (nonempty(token.access_token)) return missing("kimi", "Kimi OAuth credentials have expired")
      }
      return unknown("kimi", "Kimi OAuth credentials require native login verification")
    }
  }
  return missing("kimi", "Configure a default model and its provider credentials in config.toml")
}

function localAuth(agent: AgentType, deps: DiscoveryDeps): AuthEvidence | null {
  if (agent === "kimi") return kimiAuth(deps)
  if (agent === "antigravity") {
    // https://www.antigravity.google/docs/cli/install/: bare API keys are ignored without this provider.
    const settings = record(readState(join(deps.home, ".gemini", "antigravity-cli", "settings.json"), deps))
    if (settings.modelProvider === "gemini") {
      return nonempty(deps.env.GEMINI_API_KEY)
        ? { readiness: "ready", reason: "Antigravity Gemini provider and credentials are configured" }
        : missing(agent, "Set GEMINI_API_KEY for the configured Gemini provider")
    }
    return null
  }
  if (agent === "codex") {
    const home = nonempty(deps.env.CODEX_HOME) ? deps.env.CODEX_HOME : join(deps.home, ".codex")
    const value = readState(join(home, "auth.json"), deps)
    if (value === null) return null
    const auth = record(value)
    if (nonempty(auth.OPENAI_API_KEY)) return { readiness: "ready", reason: "Codex native API credentials found" }
    const tokens = record(auth.tokens)
    if (nonempty(tokens.access_token) && nonempty(tokens.refresh_token) && nonempty(tokens.id_token)) {
      if (expired(tokens.access_token, tokens.expires_at, deps.now(), 1_000)) {
        return missing(agent, "Codex OAuth credentials have expired")
      }
      return { readiness: "ready", reason: "Codex native OAuth credentials found" }
    }
    return missing(agent, "Codex authentication file has no complete credentials")
  }
  if (agent === "claude") {
    const home = nonempty(deps.env.CLAUDE_CONFIG_DIR) ? deps.env.CLAUDE_CONFIG_DIR : join(deps.home, ".claude")
    const value = readState(join(home, ".credentials.json"), deps)
    if (value === null) return null
    const oauth = record(record(value).claudeAiOauth)
    if (nonempty(oauth.accessToken) && nonempty(oauth.refreshToken) && typeof oauth.expiresAt === "number") {
      return expired(oauth.accessToken, oauth.expiresAt, deps.now())
        ? missing(agent, "Claude OAuth credentials have expired")
        : { readiness: "ready", reason: "Claude native OAuth credentials found" }
    }
    return missing(agent, "Claude authentication file has no complete credentials")
  }
  if (agent === "opencode") {
    const home = nonempty(deps.env.XDG_DATA_HOME) ? deps.env.XDG_DATA_HOME : join(deps.home, ".local", "share")
    const auth = record(readState(join(home, "opencode", "auth.json"), deps))
    // https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/auth/index.ts
    for (const value of Object.values(auth)) {
      const credential = record(value)
      if (credential.type === "api" && nonempty(credential.key)) {
        return { readiness: "ready", reason: "OpenCode native API credentials found" }
      }
      if (credential.type === "oauth" && nonempty(credential.access) && nonempty(credential.refresh)) {
        if (typeof credential.expires === "number" && !expired(credential.access, credential.expires, deps.now())) {
          return { readiness: "ready", reason: "OpenCode native OAuth credentials found" }
        }
      }
    }
    return missing(agent, "OpenCode has no usable native provider credentials")
  }
  return null
}

async function boundedProbe(path: string, args: readonly string[], deps: DiscoveryDeps): Promise<AuthProbeResult> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      deps.probe(path, args, {
        env: deps.env,
        timeoutMs: PROBE_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Authentication status check timed out"))
        }, PROBE_TIMEOUT_MS)
      }),
    ])
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
      throw new Error("Authentication status output exceeded the limit")
    }
    return result
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function nativeAuth(agent: AgentType, path: string, deps: DiscoveryDeps): Promise<AuthEvidence> {
  if (agent !== "claude" && agent !== "codex" && agent !== "cursor") {
    return unknown(agent, "This CLI has no supported read-only authentication status probe")
  }
  // Check installed subcommands first: older CLIs can interpret unknown commands as prompts.
  const command = agent === "claude" ? "auth" : agent === "codex" ? "login" : "status"
  const probeDeps: DiscoveryDeps = { ...deps, env: buildAgentEnv(agent, {}, deps.env) }
  const help = await boundedProbe(path, ["--help"], probeDeps)
  if (help.exitCode !== 0 || !new RegExp(`^\\s*${command}\\b`, "m").test(help.stdout)) {
    return unknown(agent, "Installed CLI does not advertise its authentication status command")
  }
  const args = agent === "cursor" ? ["status"] : [command, "status"]
  if (agent !== "cursor") {
    const subHelp = await boundedProbe(path, [command, "--help"], probeDeps)
    if (subHelp.exitCode !== 0 || !/^\s*status\b/m.test(subHelp.stdout)) {
      return unknown(agent, "Installed CLI does not advertise its authentication status command")
    }
  }
  const result = await boundedProbe(path, args, probeDeps)
  if (agent === "claude") {
    const auth = record(JSON.parse(result.stdout))
    if (
      result.exitCode === 0 &&
      auth.loggedIn === true &&
      ["claude.ai", "oauth_token", "api_key", "api_key_helper", "third_party"].includes(String(auth.authMethod))
    ) {
      return { readiness: "ready", reason: "Claude native authentication status confirmed" }
    }
    if (auth.loggedIn === false) return missing(agent)
  } else {
    const status = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`)
    if (result.exitCode === 0 && /^\s*(?:logged in|authenticated)(?:\s|:|$)/im.test(status)) {
      return { readiness: "ready", reason: `${agent} native authentication status confirmed` }
    }
    if (/^\s*(?:not logged in|not authenticated)(?:\s|[.!:]|$)/im.test(status)) return missing(agent)
  }
  return unknown(agent, "Native CLI authentication status could not be confirmed")
}

/** Confirm a supported login subcommand before invoking it on an installed CLI version. */
export async function supportsNativeLoginCommand(
  agent: AgentType,
  path: string,
  overrides: Partial<DiscoveryDeps> = {},
): Promise<boolean> {
  if (!["claude", "codex", "cursor", "grok", "opencode"].includes(agent)) return false
  const deps: DiscoveryDeps = { ...defaultDeps(), ...overrides }
  deps.env = buildAgentEnv(agent, {}, deps.env)
  try {
    const command = agent === "claude" || agent === "opencode" ? "auth" : "login"
    const help = await boundedProbe(path, ["--help"], deps)
    if (help.exitCode !== 0 || !new RegExp(`^\\s*${command}\\b`, "m").test(help.stdout)) return false
    if (command === "auth") {
      const subHelp = await boundedProbe(path, ["auth", "--help"], deps)
      return subHelp.exitCode === 0 && /^\s*login\b/m.test(subHelp.stdout)
    }
    return true
  } catch {
    return false
  }
}

/** Discover executable, authenticated local agents without running agent jobs or exposing credentials. */
export async function discoverAgents(overrides: Partial<DiscoveryDeps> = {}): Promise<AgentAvailability[]> {
  const deps: DiscoveryDeps = { ...defaultDeps(), ...overrides }
  return Promise.all(
    AGENT_TYPES.map(async (agentType): Promise<AgentAvailability> => {
      let binaryPath: string | null
      try {
        binaryPath = deps.resolveBinary(AGENT_BINARY[agentType])
        if (!binaryPath || !deps.isExecutableFile(binaryPath)) {
          return {
            agentType,
            readiness: "unavailable",
            reason: `No executable ${AGENT_BINARY[agentType]} found on PATH. ${AGENT_INSTALL_HINT[agentType]}`,
          }
        }
      } catch {
        return {
          agentType,
          readiness: "unavailable",
          reason: `Cannot inspect CLI installation. ${AGENT_INSTALL_HINT[agentType]}`,
        }
      }
      try {
        const credential =
          agentType === "kimi" || agentType === "antigravity"
            ? undefined
            : getAgentAuthEnvKeys(agentType).find((key) => nonempty(deps.env[key]))
        if (credential) {
          return {
            agentType,
            binaryPath,
            readiness: "ready",
            reason: `Credential environment variable ${credential} is set`,
          }
        }
        let auth: AuthEvidence | null
        try {
          auth = localAuth(agentType, deps)
        } catch {
          auth = unknown(agentType, "Local authentication state could not be read")
        }
        if (auth === null || (auth.readiness !== "ready" && (agentType === "claude" || agentType === "codex"))) {
          const native = await nativeAuth(agentType, binaryPath, deps)
          // Native status can confirm keychain auth or refreshable OAuth state despite a stale file.
          if (native.readiness !== "unknown" || auth === null) auth = native
        }
        return { agentType, binaryPath, ...auth }
      } catch {
        return { agentType, binaryPath, ...unknown(agentType, "Local authentication check could not complete") }
      }
    }),
  )
}
