import { spawn } from "node:child_process"

const VERSION_TIMEOUT_MS = 10_000
const REGISTRY_TIMEOUT_MS = 60_000
const INSTALL_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 1_048_576
const INSTALL_HINT = "Run npm install --global --ignore-scripts oh-my-agent@latest, confirm oma --version, then retry."
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** Accept only a complete semantic version from an OMA CLI or registry probe. */
export function parseOmaCliVersion(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed.length > 128) return null
  const version = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed
  return VERSION.test(version) ? version : null
}

export interface OmaLatestCliIO {
  run: (
    command: "oma" | "npm",
    args: string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ) => Promise<{ exitCode: number | null; stdout: string; stderr?: string }>
}

export interface OmaLatestCliResult {
  version: string
  installed: boolean
}

class CommandFailure extends Error {
  constructor(readonly kind: "timeout" | "output" | "spawn") {
    super(kind)
  }
}

const defaultIO: OmaLatestCliIO = {
  run: (command, args, { timeoutMs, maxOutputBytes }) =>
    new Promise((resolve, reject) => {
      let settled = false
      let stdout = ""
      let stderr = ""
      let outputBytes = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (error?: Error, exitCode: number | null = null) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve({ exitCode, stdout, stderr })
      }
      try {
        // Preserve the caller's PATH, registry authentication and environment.
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
        const append = (chunk: Buffer | string, destination: "stdout" | "stderr") => {
          if (settled) return
          outputBytes += Buffer.byteLength(chunk)
          if (outputBytes > maxOutputBytes) {
            child.kill("SIGKILL")
            finish(new CommandFailure("output"))
          } else if (destination === "stdout") stdout += chunk.toString()
          else stderr += chunk.toString()
        }
        child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"))
        child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"))
        child.once("error", () => finish(new CommandFailure("spawn")))
        child.once("close", (code) => finish(undefined, code))
        timer = setTimeout(() => {
          child.kill("SIGKILL")
          finish(new CommandFailure("timeout"))
        }, timeoutMs)
      } catch {
        finish(new CommandFailure("spawn"))
      }
    }),
}

function failure(stage: string, error?: unknown): Error {
  const detail =
    error instanceof CommandFailure
      ? error.kind === "timeout"
        ? "request timed out"
        : error.kind === "output"
          ? "command output exceeded the limit"
          : "command could not start"
      : "command failed"
  // Native output can contain private registry configuration or credentials.
  return new Error(`Latest OMA CLI ${stage}: ${detail}. ${INSTALL_HINT}`)
}

async function installedVersion(io: OmaLatestCliIO): Promise<string | null> {
  try {
    const result = await io.run("oma", ["--version"], {
      timeoutMs: VERSION_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    return result.exitCode === 0 ? parseOmaCliVersion(result.stdout) : null
  } catch {
    return null
  }
}

async function prepare(io: OmaLatestCliIO): Promise<OmaLatestCliResult> {
  const installed = await installedVersion(io)
  let latest: string | null
  try {
    const result = await io.run("npm", ["view", "oh-my-agent@latest", "version", "--json", "--prefer-online"], {
      timeoutMs: REGISTRY_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    if (result.exitCode !== 0) throw failure("registry lookup")
    const value: unknown = JSON.parse(result.stdout)
    latest = typeof value === "string" ? parseOmaCliVersion(value) : null
  } catch (error) {
    throw failure("registry lookup", error)
  }
  if (!latest) throw new Error(`Latest OMA CLI registry returned invalid version metadata. ${INSTALL_HINT}`)
  if (installed === latest) return { version: latest, installed: false }
  try {
    const result = await io.run("npm", ["install", "--global", "--ignore-scripts", "oh-my-agent@latest"], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    })
    if (result.exitCode !== 0) throw failure("installation")
  } catch (error) {
    throw failure("installation", error)
  }
  const confirmed = await installedVersion(io)
  if (confirmed !== latest)
    throw new Error(
      `Latest OMA CLI verification expected ${latest}, but oma --version reported ${confirmed ?? "unavailable"}. Check PATH for another OMA executable. ${INSTALL_HINT}`,
    )
  return { version: latest, installed: true }
}

const preparing = new WeakMap<OmaLatestCliIO, Promise<OmaLatestCliResult>>()

/**
 * Resolve npm's latest version for each new strict OMA attempt. Concurrent
 * preparations share one probe/install, while settled results are never cached.
 * Read-only receipt checks must use the selected executable without calling this.
 * This prepares the CLI only; setup owns project skills and custom configuration.
 */
export function ensureLatestOmaCli(options: { io?: OmaLatestCliIO } = {}): Promise<OmaLatestCliResult> {
  const io = options.io ?? defaultIO
  const current = preparing.get(io)
  if (current) return current
  const pending = prepare(io).finally(() => {
    if (preparing.get(io) === pending) preparing.delete(io)
  })
  preparing.set(io, pending)
  return pending
}
