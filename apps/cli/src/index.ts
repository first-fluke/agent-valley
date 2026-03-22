#!/usr/bin/env bun

/**
 * CLI entry point — `bun av`
 *
 * Commands:
 *   (default)  Check config, then start dashboard
 *   setup      Interactive setup wizard
 *   dev        Dashboard + orchestrator + ngrok tunnel
 *   status     Query running server status
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { program } from "commander"
import pc from "picocolors"

/** Project root = cwd where user runs `bunx av` */
const ROOT = process.cwd()

program.name("av").description("Agent Valley — AI agent orchestrator").version("0.1.0")

// ── setup ────────────────────────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard")
  .option("--edit", "Modify specific values in existing .env")
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

// ── dev ──────────────────────────────────────────────────────────────────────
program
  .command("dev")
  .description("Start dashboard + orchestrator + ngrok tunnel")
  .action(async () => {
    if (!existsSync(resolve(ROOT, ".env"))) {
      console.log(pc.yellow("No .env found. Running setup first...\n"))
      const { setup } = await import("./setup")
      await setup()
      console.log()
    }

    const port = process.env.SERVER_PORT ?? "9741"

    // Start Next.js dashboard (includes orchestrator via instrumentation.ts)
    let dashProc: ChildProcess | null = null

    const startDashboard = () => {
      dashProc = spawn("bun", ["run", "dev"], {
        cwd: resolve(ROOT, "apps/dashboard"),
        stdio: "inherit",
      })
      console.log(pc.green(`▶ Dashboard started (pid: ${dashProc.pid}) → http://localhost:${port}`))
    }

    startDashboard()

    // Start ngrok tunnel for Linear webhooks
    let ngrokProc: ChildProcess | null = null
    let ngrokUrl: string | null = null

    const startNgrok = () => {
      const which = spawnSync("which", ["ngrok"])
      if (which.status !== 0) {
        console.log(pc.yellow("⚠ ngrok not found — Linear webhooks won't reach localhost"))
        console.log(pc.dim("  Install: brew install ngrok"))
        return
      }

      ngrokProc = spawn("ngrok", ["http", port, "--log", "stdout", "--log-format", "json"], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      const timeout = setTimeout(() => {
        if (!ngrokUrl) console.log(pc.yellow("⚠ ngrok started but URL detection timed out — check ngrok dashboard"))
      }, 10_000)

      ngrokProc.stdout?.on("data", (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue
          try {
            const log = JSON.parse(line)
            if (log.url?.startsWith("https://")) {
              ngrokUrl = log.url
              clearTimeout(timeout)
              console.log(pc.green(`▶ ngrok tunnel → ${ngrokUrl}`))
              console.log(pc.dim(`  Set Linear webhook URL to: ${ngrokUrl}/api/webhook`))
            }
          } catch {
            // not JSON, skip
          }
        }
      })
    }

    startNgrok()

    // Watch config files for restart
    const chokidar = await import("chokidar")
    const watcher = chokidar.watch([resolve(ROOT, "WORKFLOW.md"), resolve(ROOT, ".env")], {
      ignoreInitial: true,
    })

    watcher.on("change", (path: string) => {
      console.log(pc.dim(`  changed: ${path}`))
      if (dashProc) {
        dashProc.kill()
        console.log(pc.yellow("↻ Restarting dashboard..."))
      }
      startDashboard()
    })

    const shutdown = () => {
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
  .option("--breakdown", "Auto-decompose into sub-issues with dependency DAG")
  .action(
    async (
      description: string | undefined,
      opts: { yes?: boolean; raw?: boolean; parent?: string; blockedBy?: string; breakdown?: boolean },
    ) => {
      const { createIssue } = await import("./issue")
      await createIssue(description, {
        yes: opts.yes,
        raw: opts.raw,
        parent: opts.parent,
        blockedBy: opts.blockedBy,
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
    try {
      const res = await fetch(`http://localhost:${port}/api/status`)
      const data = await res.json()
      console.log(JSON.stringify(data, null, 2))
    } catch {
      console.log(pc.red(`Server is not running on port ${port}`))
    }
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

// ── default: start dashboard ─────────────────────────────────────────────────
program.action(async () => {
  if (!existsSync(".env")) {
    const { setup } = await import("./setup")
    await setup()
    console.log()
  }

  const proc = spawn("bun", ["run", "dev"], {
    cwd: "apps/dashboard",
    stdio: "inherit",
  })
  proc.on("exit", (code) => process.exit(code ?? 0))
})

program.parse()
