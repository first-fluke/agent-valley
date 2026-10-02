/**
 * Supervisor — keeps the dashboard alive with auto-restart on crash.
 * Spawned by `av up` as a detached background process.
 *
 * Usage: bun apps/cli/src/supervisor.ts <dashboard-cwd> <port> [dev|start]
 */

import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig } from "@agent-valley/core/config/yaml-loader"
import { registerLinearWebhook } from "./linear-webhook-register"
import { spawnTunnel, type TunnelHandle } from "./tunnel"
import { dashboardHost, startWebhookProxy, webhookPort } from "./webhook-proxy"

const dashboardCwd = process.argv[2] ?? "."
const port = process.argv[3] ?? "9741"
const mode = process.argv[4] ?? "start"
const listenHost = dashboardHost()
const logFile = resolve(process.cwd(), ".av.log")

const MAX_RESTARTS = 20
const RESTART_DELAY = 3_000

let restarts = 0
let shuttingDown = false
let restartTimer: ReturnType<typeof setTimeout> | undefined
let tunnel: TunnelHandle | undefined
let proxy: Awaited<ReturnType<typeof startWebhookProxy>> | undefined

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [supervisor] ${msg}\n`
  appendFileSync(logFile, line)
}

let currentProc: ReturnType<typeof spawn> | null = null

function killCurrentProc(): void {
  if (currentProc && currentProc.exitCode === null) {
    try {
      currentProc.kill("SIGKILL")
    } catch {
      /* already dead */
    }
  }
  currentProc = null
}

function startDashboard(): void {
  if (shuttingDown) return
  // Ensure previous process is dead before starting a new one
  killCurrentProc()

  let proc: ReturnType<typeof spawn>

  if (mode === "start") {
    proc = spawn("bun", ["next", "start", "-p", port, "-H", listenHost], {
      cwd: dashboardCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port, HOSTNAME: listenHost },
    })
    log(`Dashboard started via next start (pid: ${proc.pid}, port: ${port})`)
  } else {
    proc = spawn("bun", ["next", "dev", "--turbopack", "-p", port, "-H", listenHost], {
      cwd: dashboardCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port, HOSTNAME: listenHost },
    })
    log(`Dashboard started via next dev (pid: ${proc.pid}, port: ${port})`)
  }

  currentProc = proc

  proc.stdout?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))
  proc.stderr?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))

  proc.on("error", (error) => {
    log(`Cannot start dashboard: ${error.message}. Install Bun and run bun install.`)
    shutdown(1)
  })

  proc.on("exit", (code, signal) => {
    currentProc = null
    log(`Dashboard exited (code: ${code}, signal: ${signal})`)
    if (shuttingDown) return
    restarts++

    if (restarts > MAX_RESTARTS) {
      log(`Max restarts (${MAX_RESTARTS}) exceeded. Giving up.`)
      shutdown(1)
      return
    }

    log(`Restarting in ${RESTART_DELAY / 1000}s... (restart ${restarts}/${MAX_RESTARTS})`)
    restartTimer = setTimeout(startDashboard, RESTART_DELAY)
  })
}

function shutdown(code = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(restartTimer)
  tunnel?.kill()
  proxy?.close()
  if (!currentProc || currentProc.exitCode !== null) process.exit(code)
  const child = currentProc
  child.once("exit", () => process.exit(code))
  child.kill("SIGTERM")
  setTimeout(() => {
    killCurrentProc()
    process.exit(code)
  }, 5_000).unref()
}

process.on("SIGINT", () => shutdown())
process.on("SIGTERM", () => shutdown())

log(`Supervisor started — port ${port}, mode ${mode}, cwd ${dashboardCwd}`)
startWebhookProxy(port, webhookPort(port))
  .then((server) => {
    proxy = server
    log(`Webhook-only proxy listening on 127.0.0.1:${webhookPort(port)}`)
    const config = loadConfig(process.cwd())
    startDashboard()
    tunnel = spawnTunnel(config.tunnel, {
      port: webhookPort(port),
      logger: { info: log, warn: log, dim: log },
    })
    tunnel.ready
      .then(async (url) => {
        if (!url || shuttingDown) return
        if (config.trackerKind === "github") {
          log(
            `Register GitHub webhook ${url}/api/webhook/github for ${config.github?.owner}/${config.github?.repo}; select Issues events and the github.webhook_secret from valley.yaml.`,
          )
        } else {
          await registerLinearWebhook(process.cwd(), url)
        }
      })
      .catch((error: unknown) => log(`Webhook registration failed: ${String(error)}`))
  })
  .catch((error: unknown) => {
    log(`Webhook proxy failed: ${String(error)}. Set SYMPHONY_WEBHOOK_PORT to an unused port.`)
    shutdown(1)
  })
