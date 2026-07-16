/**
 * AgySession — Antigravity (`agy`) CLI integration.
 *
 * Google retired the standalone `gemini` CLI (~2026-06-18) and folded its
 * capabilities into Antigravity. `agy` is the spawnable non-interactive
 * binary. This session replaces GeminiSession using the same one-shot
 * spawn-per-execute() shape as ClaudeSession — `agy` has no persistent-
 * server / ACP-equivalent mode; `--print` runs one prompt and exits.
 *
 * Mode: `agy --print` (`-p`), one process spawned per execute()
 * Input: prompt passed as the `-p` argv value (agy's documented usage —
 *   NOT stdin; see AGY_MAX_PROMPT_ARG_BYTES guard below)
 * Output: plain text on stdout, streamed line-by-line. agy print mode has
 *   no `--output-format` flag — there is no JSON/structured output and
 *   therefore no token-usage surface (see readStream()).
 *
 * Flags verified against `agy --help` (agy v1.1.3). Anything not
 * explicitly confirmed there is called out individually below.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv } from "./base-session"
import { planSandboxedSpawn } from "./sandbox"

// ── CLI surface (verified against `agy --help` v1.1.3) ─────────────────────

/** Binary name for the Antigravity non-interactive CLI. */
export const AGY_COMMAND = "agy"

/**
 * Non-interactive print mode: `agy -p "<prompt>" [flags]` runs a single
 * prompt and prints the response, then exits. Confirmed via `agy --help`
 * (also spelled `--print` / `--prompt`; `-p` used here to match the
 * documented short-form usage). The prompt is the flag's VALUE — agy has
 * no confirmed stdin-prompt fallback, unlike claude/gemini, so this
 * adapter passes it as an argv element via node's `spawn(cmd, argv[])`
 * (no shell involved — argv elements are passed to execve() literally,
 * so this is not susceptible to shell/CLI injection). The one real
 * trade-off versus stdin: the prompt becomes visible to other local users
 * via `ps`/`/proc` process listings for the process lifetime, and is
 * bounded by the OS argv size limit — see AGY_MAX_PROMPT_ARG_BYTES.
 */
export const AGY_FLAG_PRINT = "-p"

/** Auto-approval flag, mirrors claude's --dangerously-skip-permissions / gemini's --yolo. */
export const AGY_FLAG_SKIP_PERMISSIONS = "--dangerously-skip-permissions"

/**
 * agy's OWN sandbox flag (terminal/tool restrictions inside agy itself).
 * Deliberately NOT passed by default: containment for
 * --dangerously-skip-permissions comes from the OS sandbox wrapping this
 * spawn via planSandboxedSpawn (kernel-level, fail-closed) — the same
 * choice ClaudeSession makes for --dangerously-skip-permissions. agy's
 * own --sandbox is a separate, optional, agy-internal layer on top of
 * that; it is not wired here to keep containment strategy consistent
 * across claude/codex/agy. Exposed as a constant so a future config
 * option can opt into layering it on without re-deriving the flag name.
 */
export const AGY_FLAG_OWN_SANDBOX = "--sandbox"

/**
 * Session continuity: resume a prior conversation by ID. A UUID is
 * generated once per AgySession instance in start() and reused across
 * execute() calls, so repeated calls on the same session share agy-side
 * context across separate one-shot process spawns (agy has no persistent
 * process to keep this in-process like Codex's JSON-RPC server). agy also
 * has `--continue`/`-c` to resume the most recent conversation without an
 * explicit ID; not used here since this adapter always tracks its own ID.
 */
export const AGY_FLAG_CONVERSATION = "--conversation"

/** Model override flag. */
export const AGY_FLAG_MODEL = "--model"

/**
 * Execution mode: `accept-edits` (auto-apply file edits) or `plan`
 * (propose without applying). Symphony agents write code autonomously, so
 * `accept-edits` is the default; overridable via `config.options.mode`.
 */
export const AGY_FLAG_MODE = "--mode"
export const AGY_MODE_ACCEPT_EDITS = "accept-edits"
export const AGY_MODE_PLAN = "plan"

/** Timeout for print mode (agy default: 5m0s). Wired to `config.timeout`. */
export const AGY_FLAG_PRINT_TIMEOUT = "--print-timeout"

/**
 * Safety guard on prompt size before it is placed in argv. Linux caps a
 * single argv element at 128KiB (MAX_ARG_STRLEN); this stays well under
 * that (and under macOS's much larger combined ARG_MAX) so a large issue
 * body fails fast with an actionable error instead of an opaque E2BIG /
 * "Argument list too long" spawn failure.
 */
export const AGY_MAX_PROMPT_ARG_BYTES = 100_000

/** Cap on the retained "tail" of streamed output, mirrors BaseSession.buildRunResult's 10KB cap. */
const OUTPUT_TAIL_CAP = 10 * 1024

/** Format a whole-second timeout as the Go-style duration string agy's --print-timeout expects, e.g. 90 -> "90s". */
export function formatAgyTimeout(seconds: number): string {
  return `${Math.max(1, Math.round(seconds))}s`
}

export class AgySession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  private conversationId: string | null = null
  private tailBuffer = ""

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
    // Generated once per session instance; reused across execute() calls so
    // multi-turn conversations keep agy-side context via --conversation.
    this.conversationId = crypto.randomUUID()
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    const promptBytes = Buffer.byteLength(prompt, "utf-8")
    if (promptBytes > AGY_MAX_PROMPT_ARG_BYTES) {
      this.emitError(
        "CRASH",
        `AgySession: prompt is ${promptBytes} bytes, exceeding the ${AGY_MAX_PROMPT_ARG_BYTES}-byte ` +
          "safety guard on agy's `-p` argv value (agy has no confirmed stdin-prompt fallback).\n" +
          "  Fix: shorten the prompt/issue body passed to execute() (see sanitizeIssueBody / workflow " +
          "template length limits), or re-verify agy's stdin support and switch this adapter to piping " +
          "the prompt via stdin instead.",
        false,
      )
      return
    }

    this.filesChanged = []
    this.tailBuffer = ""
    this.startedAt = Date.now()

    const config = this.config
    const args = this.buildArgs(config, prompt)

    // Containment for --dangerously-skip-permissions comes from the OS
    // sandbox wrapping this spawn, not from trusting the flag itself.
    // planSandboxedSpawn() fails closed (throws) when no sandbox is
    // available unless SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: "antigravity",
        command: AGY_COMMAND,
        args,
        workspacePath: config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    this.process = spawn(plan.command, plan.args, {
      cwd: config.workspacePath,
      env: buildAgentEnv("antigravity", config.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    // Prompt is passed via argv (see AGY_FLAG_PRINT above), not stdin.
    // Close stdin immediately so agy never blocks waiting for input.
    this.process.stdin?.end()

    try {
      await this.readStream()
    } catch (err) {
      this.emitError("CRASH", `readStream failed: ${err}`, true)
    }
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return this.process.exitCode === null
  }

  // ── Args builder ─────────────────────────────────────────────────────────

  private buildArgs(config: AgentConfig, prompt: string): string[] {
    const args = [AGY_FLAG_PRINT, prompt, AGY_FLAG_SKIP_PERMISSIONS]

    const mode = (config.options?.mode as string | undefined) ?? AGY_MODE_ACCEPT_EDITS
    args.push(AGY_FLAG_MODE, mode)

    args.push(AGY_FLAG_PRINT_TIMEOUT, formatAgyTimeout(config.timeout))

    if (config.model) args.push(AGY_FLAG_MODEL, config.model)
    if (this.conversationId) args.push(AGY_FLAG_CONVERSATION, this.conversationId)

    return args
  }

  // ── Stream parser ───────────────────────────────────────────────────────
  //
  // agy print mode emits plain text only (no --output-format flag exists,
  // confirmed via `agy --help`) — every stdout line is streamed as-is via
  // an `output` event, never buffered whole (OOM safety, matches
  // ClaudeSession's "stream-only" comment). A bounded tail (last
  // OUTPUT_TAIL_CAP bytes) is retained for the final `complete` event.
  // There is no structured usage payload to parse, so `tokenUsage` is
  // always left undefined here — exactly like GeminiSession's old CLI
  // fallback did when no usageMetadata was present — and BudgetService
  // skips accumulation for this attempt.

  private readStream(): Promise<void> {
    return new Promise((resolve) => {
      const proc = this.process
      if (!proc?.stdout) {
        this.emitError("CRASH", "agy process has no stdout", false)
        resolve()
        return
      }

      const decoder = new TextDecoder()
      let buffer = ""

      proc.stdout.on("data", (chunk: Buffer) => {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          this.emitTextChunk(line)
        }
      })

      proc.stdout.on("error", () => {
        // Stream error — proceed to close
      })

      proc.once("close", (code) => {
        // Flush a trailing partial line that never got a terminating newline.
        if (buffer.trim()) this.emitTextChunk(buffer)

        const exitCode = code ?? -1
        if (exitCode === 0) {
          const result = this.buildRunResult(this.tailBuffer, this.filesChanged)
          this.emit({ type: "complete", result })
        } else {
          this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `agy exited with code ${exitCode}`, true)
        }

        resolve()
      })
    })
  }

  private emitTextChunk(text: string): void {
    this.emit({ type: "output", chunk: text })
    this.tailBuffer += text
    if (this.tailBuffer.length > OUTPUT_TAIL_CAP) {
      this.tailBuffer = this.tailBuffer.slice(-OUTPUT_TAIL_CAP)
    }
  }
}
