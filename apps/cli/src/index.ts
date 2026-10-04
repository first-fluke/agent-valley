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
import { existsSync, unlinkSync } from "node:fs"
import { resolve } from "node:path"
import { resolveProjectConfigPath } from "@agent-valley/core/config/project-config-path"
import { loadConfig, resolveGlobalConfigPath } from "@agent-valley/core/config/yaml-loader"
import { AV_VERSION } from "@agent-valley/core/version"
import { program } from "commander"
import pc from "picocolors"
import { registerAgentClientCommands } from "./agent-client-commands"
import { registerChiefCommands } from "./chief"
import { registerOrganizationCommands } from "./chief-organization"
import { watchConfig } from "./config-watch"
import { registerDoctorCommand } from "./doctor"
import { registerLinearWebhook } from "./linear-webhook-register"
import {
  assertPortAvailable,
  isProcessAlive,
  readPids,
  resolveRuntimePaths,
  resolveServerPort,
  waitForDashboard,
  writePids,
} from "./runtime"
import { registerSetupCommand } from "./setup/command"
import { readStatus } from "./status-client"
import { spawnTunnel, type TunnelHandle, type TunnelLogger } from "./tunnel"
import { dashboardHost, startWebhookProxy, webhookPort } from "./webhook-proxy"

/** Project root = cwd where user runs `bunx av` */
const ROOT = process.cwd()
const PID_FILE = resolve(ROOT, ".av.pid")
const LOG_FILE = resolve(ROOT, ".av.log")

function ensureConfig(): void {
  if (!existsSync(resolveProjectConfigPath(ROOT))) {
    console.log(pc.red("No av.yaml found. Run `av setup` first."))
    process.exit(1)
  }
}

// ── Tunnel helper ────────────────────────────────────────────────────────────

/**
 * Console-backed logger adapter for the tunnel module. Keeps picocolors
 * in the Presentation layer so the tunnel adapters stay printer-agnostic
 * and easy to unit-test.
 */
const tunnelLogger: TunnelLogger = {
  info: (msg: string) => console.log(pc.green(msg)),
  warn: (msg: string) => console.log(pc.yellow(msg)),
  dim: (msg: string) => console.log(pc.dim(msg)),
}

/** Read the configured provider before starting a public tunnel. */
function startTunnel(port: string): TunnelHandle {
  const cfg = loadConfig(ROOT)
  return spawnTunnel(cfg.tunnel, { port, logger: tunnelLogger })
}

program.name("av").description("Agent Valley — AI agent orchestrator").version(AV_VERSION)

// ── setup ────────────────────────────────────────────────────────────────────
registerSetupCommand(program)

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
  .description("Start dashboard + orchestrator + configured tunnel (background daemon)")
  .option("--dev", "Run the background daemon in development mode without a production build")
  .action(async (opts: { dev?: boolean }) => {
    ensureConfig()
    dashboardHost()
    loadConfig(ROOT)

    // Check if already running
    const existing = readPids(PID_FILE)
    if (existing && isProcessAlive(existing.dashboard)) {
      console.log(pc.yellow(`Already running (dashboard pid: ${existing.dashboard}, port: ${existing.port})`))
      console.log(pc.dim(`  Stop with: av down`))
      return
    }

    const port = resolveServerPort(ROOT)
    webhookPort(port)
    const { dashboardCwd, supervisorScript } = resolveRuntimePaths(ROOT, import.meta.dirname)
    await assertPortAvailable(port)
    await assertPortAvailable(webhookPort(port), "127.0.0.1")

    // Build first, then run in production mode (Turbopack dev eats 100% CPU)
    let mode = "dev"
    if (!opts.dev) {
      console.log(pc.dim("  Building dashboard..."))
      const build = spawnSync("bun", ["run", "build"], { cwd: dashboardCwd, stdio: "inherit" })
      if (build.status !== 0) console.log(pc.red("Build failed. Falling back to dev mode."))
      else mode = "start"
    }

    // Start supervisor as detached background process (handles auto-restart)
    const dashProc = spawn("bun", [supervisorScript, dashboardCwd, port, mode], {
      cwd: ROOT,
      stdio: "ignore",
      detached: true,
    })
    let spawnError: Error | undefined
    dashProc.once("error", (error) => {
      spawnError = error
    })
    try {
      await waitForDashboard(port, {
        isAlive: () => !spawnError && dashProc.exitCode === null && dashProc.signalCode === null && !!dashProc.pid,
      })
    } catch (error) {
      if (dashProc.pid) {
        try {
          process.kill(-dashProc.pid, "SIGTERM")
        } catch {
          dashProc.kill()
        }
      }
      throw spawnError ?? error
    }
    dashProc.unref()

    writePids(PID_FILE, {
      dashboard: dashProc.pid as number,
      port: Number(port),
      startedAt: new Date().toISOString(),
    })

    console.log(pc.green(`▶ Dashboard started (pid: ${dashProc.pid}) → http://localhost:${port}`))
    console.log(pc.dim(`  Logs: tail -f ${LOG_FILE}`))
    console.log(pc.dim(`  Stop: av down`))

    console.log(pc.dim("  Tunnel startup and webhook registration: av logs"))
  })

// ── down ─────────────────────────────────────────────────────────────────────
program
  .command("down")
  .description("Stop background dashboard + tunnel")
  .action(() => {
    const state = readPids(PID_FILE)
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
      console.log(pc.green(`▪ Tunnel stopped (pid: ${state.ngrok})`))
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
    const listenHost = dashboardHost()
    loadConfig(ROOT)
    const { dashboardCwd } = resolveRuntimePaths(ROOT, import.meta.dirname)

    const port = resolveServerPort(ROOT)
    const publicPort = webhookPort(port)
    await assertPortAvailable(port)
    let dashProc: ChildProcess | null = null
    let shuttingDown = false
    let restartTimer: ReturnType<typeof setTimeout> | undefined
    let restartRequested = false

    const startDashboard = () => {
      if (shuttingDown) return
      const child = spawn("bun", ["next", "dev", "--turbopack", "-p", port, "-H", listenHost], {
        cwd: dashboardCwd,
        stdio: "inherit",
        env: { ...process.env, HOSTNAME: listenHost },
      })
      dashProc = child
      console.log(pc.green(`▶ Dashboard started (pid: ${dashProc.pid}) → http://localhost:${port}`))

      child.on("error", (error) => {
        console.error(pc.red(`Cannot start dashboard: ${error.message}. Install Bun and run bun install.`))
        shutdown(1)
      })
      child.on("exit", (code) => {
        if (dashProc !== child) return
        dashProc = null
        if (shuttingDown) return
        if (restartRequested) {
          restartRequested = false
          startDashboard()
          return
        }
        console.log(pc.red(`✗ Dashboard exited (code ${code}). Restarting in 3s...`))
        restartTimer = setTimeout(startDashboard, 3_000)
      })
    }

    const webhookProxy = await startWebhookProxy(port, publicPort)

    // tunnel (ngrok / cloudflared / none — from av.yaml)
    const tunnel = startTunnel(publicPort)
    tunnel.ready.then((url) => {
      if (url) void registerLinearWebhook(ROOT, url)
    })

    // Both project filenames are watched so migration and removal reload the selected config.
    const watcher = await watchConfig(ROOT, resolveGlobalConfigPath(), (path) => {
      console.log(pc.dim(`  changed: ${path}`))
      console.log(pc.yellow("↻ Restarting dashboard..."))
      clearTimeout(restartTimer)
      if (dashProc) {
        restartRequested = true
        dashProc.kill()
      } else startDashboard()
    })

    const shutdown = (code = 0) => {
      shuttingDown = true
      clearTimeout(restartTimer)
      watcher.close()
      dashProc?.kill()
      tunnel.kill()
      webhookProxy.close()
      process.exit(code)
    }

    process.on("SIGINT", () => shutdown())
    process.on("SIGTERM", () => shutdown())
    startDashboard()
  })

// ── issue ────────────────────────────────────────────────────────────────────
program
  .command("issue [description]")
  .description("Create an issue in the configured Linear or GitHub tracker")
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
    const pids = readPids(PID_FILE)
    const port = resolveServerPort(ROOT, pids?.port)

    // Daemon status
    if (pids) {
      const dashAlive = isProcessAlive(pids.dashboard)
      const tunnelAlive = pids.ngrok ? isProcessAlive(pids.ngrok) : false
      console.log(dashAlive ? pc.green(`● Dashboard running (pid: ${pids.dashboard})`) : pc.red("○ Dashboard dead"))
      console.log(tunnelAlive ? pc.green(`● Tunnel running (pid: ${pids.ngrok})`) : pc.dim("○ Tunnel not running"))
      console.log()
    }

    // Orchestrator status
    try {
      const data = await readStatus(port)
      console.log(JSON.stringify(data, null, 2))
    } catch (error) {
      console.log(pc.red(error instanceof Error ? error.message : `Server is not responding on port ${port}`))
      process.exitCode = 1
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
    const port = resolveServerPort(ROOT, readPids(PID_FILE)?.port)
    const interval = Number(opts.interval) * 1000

    const render = async () => {
      try {
        const d = await readStatus(port)
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
        const bar = "█".repeat(active) + "░".repeat(Math.max(0, max - active))
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
      } catch (error) {
        process.stdout.write("\x1b[2J\x1b[H")
        console.log(pc.red(error instanceof Error ? error.message : "Server not responding. Start with: av up"))
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

registerDoctorCommand(program)
registerChiefCommands(program)
registerOrganizationCommands(program)
registerAgentClientCommands(program)

program.parseAsync().catch((error: unknown) => {
  console.error(pc.red(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
