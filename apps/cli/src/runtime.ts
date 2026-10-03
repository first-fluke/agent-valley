import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { dashboardTargetHost } from "./webhook-proxy"

export interface PidState {
  dashboard: number
  ngrok?: number
  port: number
  startedAt: string
}

export function writePids(path: string, state: PidState): void {
  writeFileSync(path, JSON.stringify(state, null, 2))
}

export function readPids(path: string): PidState | null {
  try {
    return parsePidState(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function parsePidState(raw: string): PidState | null {
  try {
    const state = JSON.parse(raw) as PidState
    const validPid = (pid: number) => Number.isSafeInteger(pid) && pid > 1
    if (
      !state ||
      !validPid(state.dashboard) ||
      (state.ngrok !== undefined && !validPid(state.ngrok)) ||
      !Number.isInteger(state.port) ||
      state.port < 1 ||
      state.port > 65535 ||
      typeof state.startedAt !== "string"
    )
      return null
    return state
  } catch {
    return null
  }
}

export function resolveServerPort(root: string, runningPort?: number): string {
  const port = Number(
    process.env.SERVER_PORT ??
      runningPort ??
      loadProjectConfig(root)?.server?.port ??
      loadGlobalConfig()?.server?.port ??
      9741,
  )
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Set SERVER_PORT or server.port in av.yaml/settings.yaml to an integer between 1 and 65535.")
  }
  return String(port)
}

export function resolveRuntimePaths(root: string, cliDir: string): { dashboardCwd: string; supervisorScript: string } {
  const dashboardCwd = resolve(root, "apps/dashboard")
  if (!existsSync(resolve(dashboardCwd, "package.json"))) {
    throw new Error(
      `Dashboard source is missing at ${dashboardCwd}. Clone https://github.com/first-fluke/agent-valley, run bun install, then run bun av setup and bun av dev from that checkout. The standalone CLI does not include the dashboard.`,
    )
  }
  const bundled = resolve(cliDir, "supervisor.js")
  const supervisorScript = existsSync(bundled) ? bundled : resolve(cliDir, "supervisor.ts")
  if (!existsSync(supervisorScript)) {
    throw new Error(`Supervisor is missing at ${supervisorScript}. Run bun av up from an intact Agent Valley checkout.`)
  }
  return { dashboardCwd, supervisorScript }
}

export async function assertPortAvailable(port: string, host = dashboardTargetHost()): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const probe = createServer()
    probe.once("error", (error) =>
      reject(
        new Error(
          `Cannot listen on ${host}:${port}: ${(error as NodeJS.ErrnoException).code ?? error.message}. Stop the existing process with av down or change server.port/SYMPHONY_WEBHOOK_PORT.`,
        ),
      ),
    )
    probe.listen(Number(port), host, () => probe.close(() => resolvePromise()))
  })
}

export interface ReadinessOptions {
  isAlive: () => boolean
  timeoutMs?: number
  pollMs?: number
  fetch?: typeof fetch
}

export async function waitForDashboard(port: string, options: ReadinessOptions): Promise<void> {
  const host = dashboardTargetHost()
  const target = host.includes(":") ? `[${host}]` : host
  const deadline = Date.now() + (options.timeoutMs ?? 60_000)
  const token = process.env.SYMPHONY_DASHBOARD_TOKEN
  while (Date.now() < deadline) {
    if (!options.isAlive()) throw new Error("Dashboard process exited during startup. Run av logs to inspect .av.log.")
    try {
      const response = await (options.fetch ?? fetch)(`http://${target}:${port}/api/health`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(Math.max(1, Math.min(2_000, deadline - Date.now()))),
      })
      if (response.ok) {
        const health = (await response.json()) as { status?: string; isRunning?: boolean }
        if (health.status === "ok" && health.isRunning === true && options.isAlive()) return
      }
    } catch {
      // Connection refusal and a compiling dev server are expected until ready.
    }
    await delay(Math.min(options.pollMs ?? 250, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Dashboard did not become ready on port ${port}. Run av logs and av doctor to diagnose startup.`)
}
