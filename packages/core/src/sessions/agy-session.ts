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
 *
 * Later builds (verified on v1.5.12) add structured print mode and an ACP
 * server. Runs that take operator messages use the former — see
 * agy-live-run.ts — and an agy without it falls back to the one-shot above.
 */

import type { AgentConfig } from "./agent-session"
import { AgyLiveRun } from "./agy-live-run"
import { BaseSession, waitForStreamCompletion } from "./base-session"
import { readJsonLines } from "./json-lines"
import { captureExhaustion, exhaustionMessage } from "./native-failure"
import { BoundedResultText, nativeResultLimitMessage } from "./native-result"
import { QUEUED_MESSAGE_GRACE_MS } from "./queued-messages"

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
 * Live input (`options.liveInput`): structured print mode that keeps stdin open
 * for operator messages — see agy-live-run.ts for the protocol. `--print=`
 * supplies the empty prompt the flag requires; the task arrives on stdin.
 */
export const AGY_FLAG_PRINT_FROM_STDIN = "--print="
export const AGY_FLAG_INPUT_FORMAT = "--input-format"
export const AGY_FLAG_OUTPUT_FORMAT = "--output-format"
export const AGY_FORMAT_STREAM_JSON = "stream-json"

/**
 * Safety guard on prompt size before it is placed in argv. Linux caps a
 * single argv element at 128KiB (MAX_ARG_STRLEN); this stays well under
 * that (and under macOS's much larger combined ARG_MAX) so a large issue
 * body fails fast with an actionable error instead of an opaque E2BIG /
 * "Argument list too long" spawn failure.
 */
export const AGY_MAX_PROMPT_ARG_BYTES = 100_000

/** Cap on diagnostic output retained after a failed process. */
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
  private finalOutput = new BoundedResultText()
  /** The live (stream-json) run that is taking messages on stdin, if any. */
  private liveRun: AgyLiveRun | null = null
  private stopRequested = false
  protected queuedMessageGraceMs = QUEUED_MESSAGE_GRACE_MS

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

    // Runs that take operator messages keep stdin open; an agy without that mode falls through to one-shot.
    if (this.config.options?.liveInput === true && (await this.executeLive(this.config, prompt))) return

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
    this.finalOutput.reset()
    this.startedAt = Date.now()

    const config = this.config
    const args = this.buildArgs(config, prompt)

    // Containment for --dangerously-skip-permissions comes from the OS
    // sandbox wrapping this spawn, not from trusting the flag itself.
    // spawnSandboxed() fails closed when no sandbox is available unless
    // SYMPHONY_ALLOW_UNSANDBOXED=1 is set. The prompt is passed via argv
    // (AGY_FLAG_PRINT), so stdin closes immediately to avoid blocking.
    const spawned = await this.spawnSandboxed({
      agentType: "antigravity",
      command: AGY_COMMAND,
      args,
      stdio: ["pipe", "pipe", "pipe"],
      closeStdin: true,
    })
    if (!spawned) return

    try {
      await this.readStream()
    } catch (err) {
      this.emitError("CRASH", `readStream failed: ${err}`, true)
    }
  }

  override isAlive(): boolean {
    if (!this.process) return this.started && this.config !== null
    return super.isAlive()
  }

  // ── Args builder ─────────────────────────────────────────────────────────

  /** `prompt: null` builds the live form: the task and later messages arrive on stdin. */
  private buildArgs(config: AgentConfig, prompt: string | null): string[] {
    const args =
      prompt === null
        ? [
            AGY_FLAG_PRINT_FROM_STDIN,
            AGY_FLAG_INPUT_FORMAT,
            AGY_FORMAT_STREAM_JSON,
            AGY_FLAG_OUTPUT_FORMAT,
            AGY_FORMAT_STREAM_JSON,
            AGY_FLAG_SKIP_PERMISSIONS,
          ]
        : [AGY_FLAG_PRINT, prompt, AGY_FLAG_SKIP_PERMISSIONS]

    const mode = (config.options?.mode as string | undefined) ?? AGY_MODE_ACCEPT_EDITS
    args.push(AGY_FLAG_MODE, mode)

    args.push(AGY_FLAG_PRINT_TIMEOUT, formatAgyTimeout(config.timeout))

    if (config.model) args.push(AGY_FLAG_MODEL, config.model)
    if (this.conversationId) args.push(AGY_FLAG_CONVERSATION, this.conversationId)

    return args
  }

  // ── Live input (stream-json) ─────────────────────────────────────────────

  /**
   * Run the prompt in a process that keeps taking messages on stdin. Returns
   * true when the run was handled here, false when this agy does not support
   * the mode and the caller should run one-shot.
   */
  private async executeLive(config: AgentConfig, prompt: string): Promise<boolean> {
    this.tailBuffer = ""
    this.startedAt = Date.now()
    this.stopRequested = false

    const spawned = await this.spawnSandboxed({
      agentType: "antigravity",
      command: AGY_COMMAND,
      args: this.buildArgs(config, null),
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (!spawned) return true
    const proc = this.process
    if (!proc?.stdout) {
      this.emitError("CRASH", "agy process has no stdout", false)
      return true
    }

    const run = new AgyLiveRun(proc.stdin, {
      model: config.model,
      graceMs: this.queuedMessageGraceMs,
      events: {
        output: (chunk) => this.emitTextChunk(chunk),
        toolUse: (tool, args) => this.emit({ type: "toolUse", tool, args }),
        fileChange: (path, changeType) => this.emit({ type: "fileChange", path, changeType }),
        activity: () => this.emit({ type: "heartbeat", timestamp: new Date().toISOString() }),
        complete: (result) => {
          this.emit({ type: "complete", result: { exitCode: 0, durationMs: this.elapsedMs(), ...result } })
          // The process only exits once stdin closes.
          proc.stdin?.end()
        },
        failed: (message, recoverable) => {
          this.emitError("CRASH", message, recoverable)
          proc.stdin?.end()
        },
      },
    })
    this.liveRun = run
    // A prompt that cannot be written means the process is already gone; its exit reports the failure.
    run.send(prompt).catch(() => {})
    const stderrExhaustion = captureExhaustion(proc.stderr)
    const flush = readJsonLines(proc.stdout, (event) => run.handleEvent(event))
    const { exitCode: code } = await waitForStreamCompletion(proc)
    flush()
    this.liveRun = null

    if (run.processExited(code) || this.terminalEventReceived) return true
    // A usage error before any stream event: this agy predates stream-json input.
    if (!run.sawEvent && !this.stopRequested && code !== null && code !== 0) return false
    this.emitError(
      code === null ? "TIMEOUT" : "CRASH",
      stderrExhaustion() ??
        exhaustionMessage(this.tailBuffer) ??
        (code === 0
          ? "agy exited without a result event. Update agy (`agy update`) and retry."
          : `agy exited with code ${code ?? "unknown"}`),
      true,
    )
    return true
  }

  /** Deliver an operator message to the running process. Rejects when it cannot be taken. */
  async sendUserMessage(text: string): Promise<void> {
    if (!this.liveRun) {
      throw new Error(
        "agy session is not accepting live input (the run already ended or is running one-shot). Restart the run with the message instead.",
      )
    }
    await this.liveRun.send(text)
  }

  override async cancel(): Promise<void> {
    this.stopRequested = true
    await super.cancel()
  }

  override async kill(): Promise<void> {
    this.stopRequested = true
    await super.kill()
  }

  // ── Stream parser ───────────────────────────────────────────────────────
  //
  // agy print mode emits plain text only (no --output-format flag exists,
  // confirmed via `agy --help`) — every stdout line is streamed as-is via
  // an `output` event. The final answer is retained within the shared native
  // bound; a separate OUTPUT_TAIL_CAP diagnostic tail is kept on failure.
  // There is no structured usage payload to parse, so `tokenUsage` is
  // always left undefined here — exactly like GeminiSession's old CLI
  // fallback did when no usageMetadata was present — and BudgetService
  // skips accumulation for this attempt.

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) {
      this.emitError("CRASH", "agy process has no stdout", false)
      return
    }

    const decoder = new TextDecoder()
    const stderrExhaustion = captureExhaustion(proc.stderr)
    let buffer = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true })
      this.finalOutput.append(text)
      if (this.finalOutput.exceeded) {
        if (buffer) this.emitTextChunk(buffer)
        buffer = ""
        this.emitTextChunk(text)
        return
      }
      buffer += text
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

    // Gated on BOTH stdout 'end' and process 'close' — see
    // waitForStreamCompletion() doc comment for why 'close' alone races
    // the final buffered 'data' chunk on a fast-exiting process.
    const { exitCode: code } = await waitForStreamCompletion(proc)

    // Flush a trailing partial line that never got a terminating newline.
    if (buffer.trim()) this.emitTextChunk(buffer)

    const exitCode = code ?? -1
    if (exitCode === 0) {
      if (this.finalOutput.exceeded) {
        this.emitError("CRASH", nativeResultLimitMessage("Antigravity"), false)
        return
      }
      const result = this.buildRunResult(this.finalOutput.text, this.filesChanged)
      if (!result) return
      this.emit({ type: "complete", result })
    } else {
      this.emitError(
        exitCode === -1 ? "TIMEOUT" : "CRASH",
        stderrExhaustion() ?? exhaustionMessage(this.tailBuffer) ?? `agy exited with code ${exitCode}`,
        true,
      )
    }
  }

  private emitTextChunk(text: string): void {
    this.emit({ type: "output", chunk: text })
    this.tailBuffer += text
    if (this.tailBuffer.length > OUTPUT_TAIL_CAP) {
      this.tailBuffer = this.tailBuffer.slice(-OUTPUT_TAIL_CAP)
    }
  }
}
