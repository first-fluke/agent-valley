/**
 * Supervisor — keeps the dashboard alive with auto-restart on crash.
 * Spawned by `av up` as a detached background process.
 *
 * Usage: bun apps/cli/src/supervisor.ts <dashboard-cwd> <port> [dev|start]
 */

import { spawn } from "node:child_process"
import { appendFileSync, existsSync, rmSync, symlinkSync } from "node:fs"
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

function startDashboard(): void {
  let proc: ReturnType<typeof spawn>

  // Production: run standalone server.js directly (no node_modules needed)
  // Monorepo standalone output mirrors the workspace structure
  const standaloneDir = resolve(dashboardCwd, ".next/standalone/apps/dashboard")
  const standaloneServer = resolve(standaloneDir, "server.js")
  if (mode === "start" && existsSync(standaloneServer)) {
    // Standalone requires static + public to be copied/linked alongside server.js
    const staticLink = resolve(standaloneDir, ".next/static")
    const publicLink = resolve(standaloneDir, "public")
    const staticSrc = resolve(dashboardCwd, ".next/static")
    const publicSrc = resolve(dashboardCwd, "public")

    try {
      rmSync(staticLink, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    try {
      rmSync(publicLink, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    if (existsSync(staticSrc)) symlinkSync(staticSrc, staticLink)
    if (existsSync(publicSrc)) symlinkSync(publicSrc, publicLink)

    proc = spawn("node", [standaloneServer], {
      cwd: standaloneDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PORT: port, HOSTNAME: "0.0.0.0" },
    })
    log(`Dashboard started via standalone (pid: ${proc.pid}, port: ${port})`)
  } else {
    // Dev mode or standalone not available
    proc = spawn("bun", ["run", mode === "start" ? "start" : "dev"], {
      cwd: dashboardCwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    log(`Dashboard started via bun run ${mode} (pid: ${proc.pid})`)
  }

  proc.stdout?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))
  proc.stderr?.on("data", (chunk: Buffer) => appendFileSync(logFile, chunk))

  proc.on("exit", (code, signal) => {
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
