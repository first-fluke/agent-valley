/**
 * Supervisor — keeps the dashboard alive with auto-restart on crash.
 * Spawned by `av up` as a detached background process.
 *
 * Usage: bun apps/cli/src/supervisor.ts <dashboard-cwd> <port> [dev|start]
 */

import { spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { resolve } from "node:path"

const dashboardCwd = process.argv[2] ?? "."
const port = process.argv[3] ?? "9741"
const mode = process.argv[4] ?? "start"
const logFile = resolve(process.cwd(), ".av.log")

const MAX_RESTARTS = 20
const RESTART_DELAY = 3_000

let restarts = 0

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
  // Ensure previous process is dead before starting a new one
  killCurrentProc()

  const envFile = resolve(dashboardCwd, "../../.env")
  let proc: ReturnType<typeof spawn>

  if (mode === "start") {
    proc = spawn("bun", [`--env-file=${envFile}`, "next", "start", "-p", port], {
      cwd: dashboardCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0" },
    })
    log(`Dashboard started via next start (pid: ${proc.pid}, port: ${port})`)
  } else {
    proc = spawn("bun", [`--env-file=${envFile}`, "next", "dev", "--turbopack", "-p", port], {
      cwd: dashboardCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0" },
    })
    log(`Dashboard started via next dev (pid: ${proc.pid}, port: ${port})`)
  }

  currentProc = proc

  proc.stdout?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))
  proc.stderr?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))

  proc.on("exit", (code, signal) => {
    currentProc = null
    log(`Dashboard exited (code: ${code}, signal: ${signal})`)
    restarts++

    if (restarts > MAX_RESTARTS) {
      log(`Max restarts (${MAX_RESTARTS}) exceeded. Giving up.`)
      process.exit(1)
    }

    log(`Restarting in ${RESTART_DELAY / 1000}s... (restart ${restarts}/${MAX_RESTARTS})`)
    setTimeout(startDashboard, RESTART_DELAY)
  })
}

log(`Supervisor started — port ${port}, mode ${mode}, cwd ${dashboardCwd}`)
startDashboard()
