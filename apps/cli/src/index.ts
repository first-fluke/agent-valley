/**
 * CLI entry point — `av` / `agent-valley`
 *
 * Commands:
 *   up       Start dashboard + ngrok as background daemon
 *   down     Stop background daemon
 *   dev      Start in foreground (with file watching + auto-restart)
 *   status   Query orchestrator status
 *   issue    Create a Linear issue
 *   setup    Interactive setup wizard
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { program } from "commander"
import pc from "picocolors"

/** Project root = cwd where user runs `bunx av` */
const ROOT = process.cwd()
const PID_FILE = resolve(ROOT, ".av.pid")
const LOG_FILE = resolve(ROOT, ".av.log")

// ── PID file helpers ─────────────────────────────────────────────────────────

interface PidState {
  dashboard: number
  ngrok?: number
  port: number
  startedAt: string
}

function writePids(state: PidState): void {
  writeFileSync(PID_FILE, JSON.stringify(state, null, 2))
}

function readPids(): PidState | null {
  if (!existsSync(PID_FILE)) return null
  try {
    return JSON.parse(readFileSync(PID_FILE, "utf-8"))
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ensureConfig(): void {
  if (!existsSync(resolve(ROOT, "valley.yaml"))) {
    console.log(pc.red("No valley.yaml found. Run `av setup` first."))
    process.exit(1)
  }
}

// ── ngrok helper ─────────────────────────────────────────────────────────────

function spawnNgrok(port: string): ChildProcess | null {
  const which = spawnSync("which", ["ngrok"])
  if (which.status !== 0) {
    console.log(pc.yellow("⚠ ngrok not found — Linear webhooks won't reach localhost"))
    console.log(pc.dim("  Install: brew install ngrok"))
    return null
  }

  const proc = spawn("ngrok", ["http", port, "--log", "stdout", "--log-format", "json"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  let found = false
  proc.stdout?.on("data", (chunk: Buffer) => {
    if (found) return
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue
      try {
        const log = JSON.parse(line)
        if (log.url?.startsWith("https://")) {
          found = true
          console.log(pc.green(`▶ ngrok → ${log.url}`))
          console.log(pc.dim(`  Webhook URL: ${log.url}/api/webhook`))
        }
      } catch {
        // not JSON
      }
    }
  })

  return proc
}

program.name("av").description("Agent Valley — AI agent orchestrator").version("0.1.0")

// ── setup ────────────────────────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard")
  .option("--edit", "Modify specific values in existing config")
  .action(async (opts: { edit?: boolean }) => {
    if (opts.edit) {
      const { setupEdit } = await import("./setup")
      await setupEdit()
    } else {
      const { setup } = await import("./setup")
      await setup()
    }
  })

// ── invite ───────────────────────────────────────────────────────────────────
program
  .command("invite")
  .description("Copy team config to clipboard for new members")
  .action(async () => {
    const { invite } = await import("./invite")
    await invite()
  })

// ── up ───────────────────────────────────────────────────────────────────────
program
  .command("up")
  .description("Start dashboard + orchestrator + ngrok (background daemon)")
  .action(async () => {
    ensureConfig()

    // Check if already running
    const existing = readPids()
    if (existing && isProcessAlive(existing.dashboard)) {
      console.log(pc.yellow(`Already running (dashboard pid: ${existing.dashboard}, port: ${existing.port})`))
      console.log(pc.dim(`  Stop with: av down`))
      return
    }

    const port = process.env.SERVER_PORT ?? "9741"
    const dashboardCwd = resolve(ROOT, "apps/dashboard")
    const supervisorScript = resolve(import.meta.dirname, "supervisor.js")

    // Build first, then run in production mode (Turbopack dev eats 100% CPU)
    console.log(pc.dim("  Building dashboard..."))
    const build = spawnSync("bun", ["run", "build"], { cwd: dashboardCwd, stdio: "inherit" })
    if (build.status !== 0) {
      console.log(pc.red("Build failed. Falling back to dev mode."))
    }
    const mode = build.status === 0 ? "start" : "dev"

    // Start supervisor as detached background process (handles auto-restart)
    const dashProc = spawn("bun", [supervisorScript, dashboardCwd, port, mode], {
      cwd: ROOT,
      stdio: "ignore",
      detached: true,
    })
    dashProc.unref()

    // Start ngrok
    const ngrokProc = spawnNgrok(port)
    ngrokProc?.unref()

    // Write PID file
    writePids({
      dashboard: dashProc.pid ?? 0,
      ngrok: ngrokProc?.pid,
      port: Number(port),
      startedAt: new Date().toISOString(),
    })

    console.log(pc.green(`▶ Dashboard started (pid: ${dashProc.pid}) → http://localhost:${port}`))
    console.log(pc.dim(`  Logs: tail -f ${LOG_FILE}`))
    console.log(pc.dim(`  Stop: av down`))

    // Wait a moment for ngrok URL detection, then exit
    await new Promise((r) => setTimeout(r, 5_000))
  })

// ── down ─────────────────────────────────────────────────────────────────────
program
  .command("down")
  .description("Stop background dashboard + ngrok")
  .action(() => {
    const state = readPids()
    if (!state) {
      console.log(pc.yellow("Not running (no .av.pid found)"))
      return
    }

    let stopped = 0

    if (isProcessAlive(state.dashboard)) {
      // Kill process group (dashboard + its children)
      try {
        process.kill(-state.dashboard, "SIGTERM")
      } catch {
        process.kill(state.dashboard, "SIGTERM")
      }
      console.log(pc.green(`▪ Dashboard stopped (pid: ${state.dashboard})`))
      stopped++
    }

    if (state.ngrok && isProcessAlive(state.ngrok)) {
      try {
        process.kill(-state.ngrok, "SIGTERM")
      } catch {
        process.kill(state.ngrok, "SIGTERM")
      }
      console.log(pc.green(`▪ ngrok stopped (pid: ${state.ngrok})`))
      stopped++
    }

    unlinkSync(PID_FILE)

    if (stopped === 0) {
      console.log(pc.yellow("Processes were already dead. Cleaned up PID file."))
    } else {
      console.log(pc.green(`✓ Stopped ${stopped} process(es)`))
    }
  })

// ── dev (foreground) ─────────────────────────────────────────────────────────
program
  .command("dev")
  .description("Start in foreground (with file watching + auto-restart)")
  .action(async () => {
    ensureConfig()

    const port = process.env.SERVER_PORT ?? "9741"
    let dashProc: ChildProcess | null = null
    let shuttingDown = false

    const startDashboard = () => {
      dashProc = spawn("bun", ["run", "dev"], {
        cwd: resolve(ROOT, "apps/dashboard"),
        stdio: "inherit",
      })
      console.log(pc.green(`▶ Dashboard started (pid: ${dashProc.pid}) → http://localhost:${port}`))

      dashProc.on("exit", (code) => {
        if (shuttingDown) return
        console.log(pc.red(`✗ Dashboard exited (code ${code}). Restarting in 3s...`))
        setTimeout(startDashboard, 3_000)
      })
    }

    startDashboard()

    // ngrok
    const ngrokProc = spawnNgrok(port)

    // Watch config files
    const chokidar = await import("chokidar")
    const watcher = chokidar.watch([resolve(ROOT, "valley.yaml")], {
      ignoreInitial: true,
    })

    watcher.on("change", (path: string) => {
      console.log(pc.dim(`  changed: ${path}`))
      shuttingDown = true
      dashProc?.kill()
      console.log(pc.yellow("↻ Restarting dashboard..."))
      shuttingDown = false
      startDashboard()
    })

    const shutdown = () => {
      shuttingDown = true
      watcher.close()
      dashProc?.kill()
      ngrokProc?.kill()
      process.exit(0)
    }

    process.on("SIGINT", shutdown)
    process.on("SIGTERM", shutdown)
  })

// ── issue ────────────────────────────────────────────────────────────────────
program
  .command("issue [description]")
  .description("Create a Linear issue (triggers agent automatically)")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--raw", "Skip Claude CLI expansion, use input as-is")
  .option("--parent <identifier>", "Create as sub-issue of the given parent (e.g. ACR-10)")
  .option("--blocked-by <identifier>", "Mark as blocked by the given issue (e.g. ACR-12)")
  .option("--scope <name>", "Attach scope label for routing (e.g. place-haejo → scope:place-haejo)")
  .option("--breakdown", "Auto-decompose into sub-issues with dependency DAG")
  .action(
    async (
      description: string | undefined,
      opts: { yes?: boolean; raw?: boolean; parent?: string; blockedBy?: string; scope?: string; breakdown?: boolean },
    ) => {
      const { createIssue } = await import("./issue")
      await createIssue(description, {
        yes: opts.yes,
        raw: opts.raw,
        parent: opts.parent,
        blockedBy: opts.blockedBy,
        scope: opts.scope,
        breakdown: opts.breakdown,
      })
    },
  )

// ── status ───────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show orchestrator status")
  .action(async () => {
    const port = process.env.SERVER_PORT ?? "9741"
    const pids = readPids()

    // Daemon status
    if (pids) {
      const dashAlive = isProcessAlive(pids.dashboard)
      const ngrokAlive = pids.ngrok ? isProcessAlive(pids.ngrok) : false
      console.log(dashAlive ? pc.green(`● Dashboard running (pid: ${pids.dashboard})`) : pc.red("○ Dashboard dead"))
      console.log(ngrokAlive ? pc.green(`● ngrok running (pid: ${pids.ngrok})`) : pc.dim("○ ngrok not running"))
      console.log()
    }

    // Orchestrator status
    try {
      const res = await fetch(`http://localhost:${port}/api/status`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch {
      console.log(pc.red(`Server is not responding on port ${port}`))
    }
  })

// ── logs ─────────────────────────────────────────────────────────────────────
program
  .command("logs")
  .description("Tail dashboard + orchestrator logs")
  .option("-n, --lines <n>", "Number of lines to show initially", "50")
  .action((opts: { lines: string }) => {
    if (!existsSync(LOG_FILE)) {
      console.log(pc.yellow("No logs found. Start with: av up"))
      return
    }
    const tail = spawn("tail", ["-n", opts.lines, "-f", LOG_FILE], { stdio: "inherit" })
    process.on("SIGINT", () => {
      tail.kill()
      process.exit(0)
    })
    process.on("SIGTERM", () => {
      tail.kill()
      process.exit(0)
    })
  })

// ── top ──────────────────────────────────────────────────────────────────────
program
  .command("top")
  .description("Live agent status monitor")
  .option("-i, --interval <seconds>", "Refresh interval", "2")
  .action(async (opts: { interval: string }) => {
    const port = process.env.SERVER_PORT ?? "9741"
    const interval = Number(opts.interval) * 1000

    const render = async () => {
      try {
        const res = await fetch(`http://localhost:${port}/api/status`)
        const d = (await res.json()) as Record<string, unknown>
        const workspaces = (d.activeWorkspaces as Array<Record<string, unknown>>) ?? []
        const config = (d.config as Record<string, unknown>) ?? {}
        const waiting = (d.waitingIssues as number) ?? 0
        const retry = (d.retryQueueSize as number) ?? 0

        // Clear screen
        process.stdout.write("\x1b[2J\x1b[H")

        console.log(pc.bold("Agent Valley — Live Monitor"))
        console.log(pc.dim(`http://localhost:${port}  |  ${new Date().toLocaleTimeString()}`))
        console.log()

        // Summary bar
        const active = workspaces.length
        const max = (config.maxParallel as number) ?? 5
        const bar = "█".repeat(active) + "░".repeat(max - active)
        console.log(`  Agents  [${active >= max ? pc.red(bar) : pc.green(bar)}] ${active}/${max}`)
        console.log(
          `  Waiting ${pc.yellow(String(waiting))}  Retry ${retry > 0 ? pc.red(String(retry)) : pc.dim(String(retry))}`,
        )
        console.log()

        if (workspaces.length === 0) {
          console.log(pc.dim("  No active agents"))
        } else {
          // Table header
          console.log(
            `  ${pc.dim("ISSUE".padEnd(10))}${pc.dim("STATUS".padEnd(10))}${pc.dim("DURATION".padEnd(12))}${pc.dim("LAST OUTPUT")}`,
          )
          console.log(pc.dim(`  ${"─".repeat(70)}`))

          for (const w of workspaces) {
            const key = ((w.key as string) ?? "???").padEnd(10)
            const status = (w.status as string) ?? "?"
            const startedAt = (w.startedAt as string) ?? ""
            const elapsed = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : 0
            const mins = Math.floor(elapsed / 60)
            const secs = elapsed % 60
            const duration = `${mins}m${String(secs).padStart(2, "0")}s`.padEnd(12)
            const output = ((w.lastOutput as string) ?? "").slice(0, 40)

            const statusColored = status === "running" ? pc.green("●") : pc.yellow("○")
            console.log(`  ${key}${statusColored} ${status.padEnd(8)}${pc.dim(duration)}${pc.dim(output)}`)
          }
        }

        console.log()
        console.log(pc.dim("  Press Ctrl+C to exit"))
      } catch {
        process.stdout.write("\x1b[2J\x1b[H")
        console.log(pc.red("  Server not responding. Start with: av up"))
        console.log(pc.dim("  Press Ctrl+C to exit"))
      }
    }

    await render()
    const timer = setInterval(render, interval)
    process.on("SIGINT", () => {
      clearInterval(timer)
      process.stdout.write("\n")
      process.exit(0)
    })
    process.on("SIGTERM", () => {
      clearInterval(timer)
      process.exit(0)
    })

    // Keep process alive
    await new Promise(() => {})
  })

// ── login ────────────────────────────────────────────────────────────────────
program
  .command("login")
  .description("Login to Agent Valley team (Supabase auth)")
  .action(async () => {
    const { login } = await import("./login")
    await login()
  })

// ── logout ───────────────────────────────────────────────────────────────────
program
  .command("logout")
  .description("Logout from Agent Valley team")
  .action(async () => {
    const { logout } = await import("./login")
    await logout()
  })

// ── default: show help ───────────────────────────────────────────────────────
program.action(() => {
  program.help()
})

program.parse()
