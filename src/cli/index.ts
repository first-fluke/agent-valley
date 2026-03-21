#!/usr/bin/env bun

/**
 * CLI entry point — `bun agent-valley`
 *
 * Commands:
 *   (default)  Check config, then start server
 *   setup      Interactive setup wizard
 *   dev        Server + file watcher (auto-restart on changes)
 *   status     Query running server status
 */

import { program } from "commander"
import pc from "picocolors"

program
  .name("agent-valley")
  .description("Agent Valley — AI agent orchestrator")
  .version("0.1.0")

// ── setup ────────────────────────────────────────────────────────────────────
program
  .command("setup")
  .description("Interactive setup wizard")
  .action(async () => {
    const { setup } = await import("./setup")
    await setup()
  })

// ── dev ──────────────────────────────────────────────────────────────────────
program
  .command("dev")
  .description("Start server with file watching (auto-restart)")
  .action(async () => {
    if (!(await Bun.file(".env").exists())) {
      console.log(pc.yellow("No .env found. Running setup first...\n"))
      const { setup } = await import("./setup")
      await setup()
      console.log()
    }

    const chokidar = await import("chokidar")

    let proc: ReturnType<typeof Bun.spawn> | null = null

    const start = () => {
      proc = Bun.spawn(["bun", "run", "src/main.ts"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      })
      console.log(pc.green("▶ Server started (pid: " + proc.pid + ")"))
    }

    const restart = async () => {
      if (proc) {
        proc.kill()
        await proc.exited
        console.log(pc.yellow("↻ Restarting..."))
      }
      start()
    }

    start()

    const watcher = chokidar.watch(["WORKFLOW.md", ".env"], {
      ignoreInitial: true,
    })

    watcher.on("change", (path: string) => {
      console.log(pc.dim(`  changed: ${path}`))
      restart()
    })

    const shutdown = () => {
      watcher.close()
      proc?.kill()
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
  .action(async (description: string | undefined, opts: { yes?: boolean; raw?: boolean }) => {
    const { createIssue } = await import("./issue")
    await createIssue(description, { yes: opts.yes, raw: opts.raw })
  })

// ── status ───────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show orchestrator status")
  .action(async () => {
    const port = process.env.SERVER_PORT ?? "9741"
    try {
      const res = await fetch(`http://localhost:${port}/status`)
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

// ── default: start server ────────────────────────────────────────────────────
program.action(async () => {
  if (!(await Bun.file(".env").exists())) {
    const { setup } = await import("./setup")
    await setup()
    console.log()

    // Spawn fresh process so Bun picks up the newly created .env
    const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    process.exit(proc.exitCode ?? 0)
    return
  }

  await import("../main")
})

program.parse()
