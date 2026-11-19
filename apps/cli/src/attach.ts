/**
 * `av attach [issue]` — follow one issue's live thread in the terminal and
 * talk to the actor working on it.
 *
 * Presentation only: the thread comes from `/api/thread`, and every line the
 * operator types is forwarded to `/api/intervention`, where the orchestrator
 * decides what it means for the run.
 */

import { clearLine, createInterface, cursorTo } from "node:readline"
import { capabilitiesFor } from "@agent-valley/core/agent-registry"
import type { InterventionCommand } from "@agent-valley/core/domain/ports/agent-runner"
import type { Command } from "commander"
import pc from "picocolors"
import {
  type ActiveIssue,
  DashboardRequestError,
  findActiveIssue,
  followThread,
  listActiveIssues,
  sendIntervention,
} from "./attach-client"
import { ATTACH_HELP, parseAttachInput, ThreadPrinter } from "./attach-render"
import { readPids, resolveServerPort } from "./runtime"
import { readStatus } from "./status-client"

export interface AttachOptions {
  port: string
  /** Earlier thread entries shown when attaching. */
  lines: number
  /** Read messages and commands from `input`; false follows only. */
  interactive: boolean
}

export interface AttachDeps {
  readStatus: typeof readStatus
  followThread: typeof followThread
  sendIntervention: typeof sendIntervention
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream & { isTTY?: boolean }
  /** Aborts when the operator interrupts the process. */
  signal: AbortSignal
  /** Pause before reconnecting a dropped thread stream. */
  retryDelayMs?: number
}

const DEFAULT_RETRY_DELAY_MS = 3_000
const DEFAULT_LINES = 30

type Target = { issueKey: string; active?: ActiveIssue } | { error: string }

/** Pick the issue to attach to: the one named, or the only one running. */
export function resolveAttachTarget(status: Record<string, unknown>, issueArg: string | undefined): Target {
  const requested = issueArg?.trim()
  if (requested) {
    const active = findActiveIssue(status, requested)
    return { issueKey: active?.issueKey ?? requested, active }
  }
  const running = listActiveIssues(status)
  if (running.length === 1 && running[0]) return { issueKey: running[0].issueKey, active: running[0] }
  if (running.length === 0) {
    return {
      error:
        "No actors are running. Move an issue to Todo to start one, or pass an issue key to wait for its next run: av attach PROJ-12",
    }
  }
  const choices = running.map((issue) => `  av attach ${issue.issueKey}   (${issue.agentType ?? "starting"})`)
  return { error: ["Several actors are running. Pass the issue to attach to:", ...choices].join("\n") }
}

/** Run an attach session until the operator detaches. Resolves with the process exit code. */
export async function runAttach(
  issueArg: string | undefined,
  options: AttachOptions,
  deps: AttachDeps,
): Promise<number> {
  const tty = Boolean(deps.output.isTTY)
  let status: Record<string, unknown>
  try {
    status = await deps.readStatus(options.port)
  } catch (error) {
    deps.output.write(`${pc.red(errorText(error))}\n`)
    return 1
  }
  const target = resolveAttachTarget(status, issueArg)
  if ("error" in target) {
    deps.output.write(`${pc.yellow(target.error)}\n`)
    return 1
  }
  const { issueKey } = target

  const session = new AbortController()
  const detach = () => session.abort()
  if (deps.signal.aborted) detach()
  else deps.signal.addEventListener("abort", detach, { once: true })

  const rl = options.interactive
    ? createInterface({ input: deps.input, output: deps.output, terminal: tty, prompt: "> " })
    : null

  // Thread lines arrive while the operator is typing: clear the prompt line,
  // write, then redraw the prompt with whatever was typed so far.
  const print = (text: string) => {
    if (rl && tty) {
      clearLine(deps.output, 0)
      cursorTo(deps.output, 0)
    }
    deps.output.write(`${text}\n`)
    if (rl && tty && !session.signal.aborted) rl.prompt(true)
  }

  print(pc.bold(`Attached to ${issueKey}`) + pc.dim(` · ${describeRun(target.active)}`))
  if (rl) print(pc.dim("Type a message and press Enter to send it. /help lists commands, /quit detaches."))

  const printer = new ThreadPrinter(print, { dim: pc.dim, accent: pc.cyan })
  let fatal: string | null = null

  const following = (async () => {
    while (!session.signal.aborted) {
      try {
        await deps.followThread(
          options.port,
          issueKey,
          {
            onBacklog: (backlog) => printer.backlog(backlog, options.lines),
            onUpdate: (update) => printer.update(update),
            onUnavailable: (message) => print(pc.yellow(message)),
          },
          session.signal,
        )
      } catch (error) {
        if (error instanceof DashboardRequestError) {
          fatal = error.message
          detach()
          return
        }
        // Anything else is a dropped connection; fall through and reconnect.
      }
      if (session.signal.aborted) return
      printer.flush()
      print(pc.dim("Thread connection lost. Reconnecting…"))
      await delay(deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS, session.signal)
    }
  })()

  const handleLine = async (line: string): Promise<void> => {
    const parsed = parseAttachInput(line)
    if (parsed.type === "empty") return
    if (parsed.type === "help") return print(ATTACH_HELP)
    if (parsed.type === "unknown") return print(pc.yellow(`Unknown command /${parsed.name}. Type /help for the list.`))
    if (parsed.type === "quit") return detach()

    const command: InterventionCommand =
      parsed.type === "message" ? { kind: "append_prompt", text: parsed.text } : parsed.command

    // The attempt id changes whenever the run restarts, so look it up per command.
    let active: ActiveIssue | undefined
    try {
      active = findActiveIssue(await deps.readStatus(options.port), issueKey)
    } catch (error) {
      return print(pc.red(`Not sent. ${errorText(error)}`))
    }
    if (!active?.attemptId) {
      return print(pc.yellow(`Not sent: no run is active for ${issueKey} right now. Try again once it starts.`))
    }
    if (active.agentType) {
      const supported = capabilitiesFor(active.agentType)
      if (!supported.includes(command.kind)) {
        const names = supported.map(commandLabel).join(", ")
        return print(
          pc.yellow(
            `Not sent: ${active.agentType} does not support ${commandLabel(command.kind)}. Available: ${names}.`,
          ),
        )
      }
    }
    const outcome = await deps.sendIntervention(options.port, active.attemptId, command)
    if (!outcome.ok) print(pc.red(`Not sent. ${outcome.message}`))
  }

  // Lines are handled one at a time so commands reach the run in typed order.
  let handling: Promise<void> = Promise.resolve()
  if (rl) {
    rl.on("line", (line) => {
      handling = handling
        .then(() => handleLine(line))
        .then(() => {
          if (tty && !session.signal.aborted) rl.prompt()
        })
    })
    rl.on("SIGINT", detach)
    rl.on("close", detach) // end of input (Ctrl+D or a closed pipe)
    if (tty) rl.prompt()
  }

  await aborted(session.signal)
  await following
  await handling
  printer.flush()
  deps.signal.removeEventListener("abort", detach)
  rl?.close()

  if (fatal) {
    deps.output.write(`${pc.red(fatal)}\n`)
    return 1
  }
  deps.output.write(`${pc.dim(`Detached from ${issueKey}. The actor keeps running.`)}\n`)
  return 0
}

export function registerAttachCommand(program: Command, context: { root: string; pidFile: string }): void {
  program
    .command("attach [issue]")
    .description("Follow an actor's live thread and message, pause, resume, or abort it")
    .option("-n, --lines <n>", "Earlier thread entries to show when attaching", String(DEFAULT_LINES))
    .option("--no-input", "Follow only; do not read messages or commands from stdin")
    .action(async (issue: string | undefined, opts: { lines: string; input: boolean }) => {
      const interrupt = new AbortController()
      const onSignal = () => interrupt.abort()
      process.once("SIGINT", onSignal)
      process.once("SIGTERM", onSignal)
      const code = await runAttach(
        issue,
        {
          port: resolveServerPort(context.root, readPids(context.pidFile)?.port),
          lines: parseLines(opts.lines),
          interactive: opts.input,
        },
        {
          readStatus,
          followThread,
          sendIntervention,
          input: process.stdin,
          output: process.stdout,
          signal: interrupt.signal,
        },
      )
      process.exit(code)
    })
}

/** A non-negative entry count; anything else falls back to the default. */
export function parseLines(value: string): number {
  const lines = Number.parseInt(value, 10)
  return Number.isInteger(lines) && lines >= 0 ? lines : DEFAULT_LINES
}

function describeRun(active: ActiveIssue | undefined): string {
  if (!active?.attemptId) return "no run is active yet; waiting for activity"
  return active.agentType ?? "running"
}

function commandLabel(kind: InterventionCommand["kind"]): string {
  return kind === "append_prompt" ? "messages" : `/${kind}`
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // A refused connection surfaces as a bare "fetch failed"; say what to do about it.
  return /fetch failed|ECONNREFUSED|Unable to connect/i.test(message)
    ? "Cannot reach the dashboard. Start it with: av up"
    : message
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener("abort", () => resolve(), { once: true })
  })
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}
