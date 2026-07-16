/**
 * GrokSession — Grok Build (xAI) CLI with streaming NDJSON output.
 *
 * Mode: grok --single "<prompt>" --output-format streaming-json --always-approve
 * Input: prompt passed as the --single argument value (Node spawn uses an
 *   argv array, not a shell, so this carries no shell-injection risk —
 *   unlike ClaudeSession, Grok Build's confirmed flag surface has no
 *   documented stdin-prompt mode, so stdin is not used here).
 * Output: NDJSON lines, one JSON event per line.
 *
 * // verified against grok --help v0.2.101
 * Confirmed flags (verbatim from `grok --help`, Grok Build v0.2.101,
 * ~/.grok/bin/grok):
 *   -p / --single "<prompt>"   single-turn prompt, headless entry point
 *   --output-format plain|json|streaming-json   (default plain)
 *   --always-approve            auto-approve all tool executions
 *   --prompt-json <JSON>        alternative structured-prompt input (unused here)
 *   --json-schema <SCHEMA>      constrains output to a schema (unused here)
 *   --allow/--deny/--disallowed-tools   permission rules (unused here)
 *   --agent/--agents/--continue/-c/--cwd/--fork-session/--session-id
 *
 * NOT wired in this adapter (out of scope for the first round, per the
 * assigning agent — see result-grok-adapter.md):
 *   --best-of-n <N>   run N ways in parallel, pick best
 *   --check           append a self-verification loop
 *
 * Model routing: Grok Build's `--help` output has no `--model` flag —
 * model selection is documented as routing through `~/.grok/config.toml`
 * or an `--agent <NAME>` definition, not a per-invocation CLI flag.
 * `config.model` is therefore NOT forwarded to argv here (there is
 * nothing verified to forward it to). This is a known gap for a future
 * round once agent-def-based model routing is designed.
 *
 * // verified against real `grok --output-format streaming-json` output (Grok Build v0.2.101, grok-4.5)
 * NDJSON event schema (streaming-json mode — one JSON object per line):
 *   {"type":"thought","data":"<reasoning text chunk>"}
 *     Reasoning/CoT stream. NOT part of the answer — dropped from
 *     `RunResult.output`; surfaced as a `heartbeat` event so the
 *     orchestrator still sees liveness during long reasoning spans.
 *   {"type":"text","data":"<answer text chunk>"}
 *     The actual answer, streamed chunk by chunk. `.data` is emitted as
 *     an `output` event per chunk and concatenated (bounded to the last
 *     10KB — see `appendOutputTail`) to build `RunResult.output`, since
 *     unlike Claude's `result` event, grok's terminal `end` event does
 *     NOT carry the final answer text itself.
 *   {"type":"end","stopReason":"EndTurn","sessionId":"...","requestId":"...",
 *    "usage":{"input_tokens":N,"cache_read_input_tokens":N,"output_tokens":N,
 *    "reasoning_tokens":N,"total_tokens":N},"num_turns":N,
 *    "modelUsage":{"grok-4.5":{"inputTokens":N,"outputTokens":N,
 *    "cacheReadInputTokens":N,"modelCalls":N}}}
 *     Terminal event — triggers `complete`. `usage.input_tokens` /
 *     `usage.output_tokens` map directly to `tokenUsage.input` /
 *     `tokenUsage.output`. `cache_read_input_tokens` and
 *     `reasoning_tokens` are deliberately NOT folded into `input` —
 *     `TokenUsage` has no separate cache/reasoning fields, and folding
 *     them in would silently inflate billed-input numbers fed to
 *     BudgetService beyond what `usage.input_tokens` itself reports.
 *     They are ignored rather than guessed into a possibly-wrong bucket.
 *     `tokenUsage.model` is the single key of `modelUsage` (e.g.
 *     `"grok-4.5"`), falling back to `config.model` then `"grok"`.
 *
 * `--output-format json` (single-object mode) is NOT used by this
 * adapter (only `streaming-json` is invoked) and is therefore not parsed
 * here — noted for reference only: `{"text":"...", "stopReason":...,
 * "usage":{...}, "modelUsage":{...}}` with the answer at the top-level
 * `text` field.
 *
 * Error/failure signal: the real captured schema (thought/text/end) does
 * not include an example of a failed run, so `end.error` /
 * `end.is_error` handling below is a conservative best-effort guess
 * (mirrors the ClaudeSession/GeminiSession convention), NOT confirmed
 * against real output. The primary, confirmed failure signal is the
 * process exit code (see `readStream()` below).
 *
 * Tool-call event shape: NOT confirmed. The real capture only exercised
 * thought/text/end — the reproduction prompt never triggered a tool
 * call. `handleToolUse()` below is kept as a best-effort placeholder
 * (aliases modeled on common agentic-CLI conventions) so `filesChanged`
 * has a chance of being populated, but it must be verified against a
 * real tool-invoking `grok` run in a follow-up round.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv } from "./base-session"
import { planSandboxedSpawn } from "./sandbox"

export const GROK_COMMAND = "grok"

/** Max bytes of concatenated answer text retained for RunResult.output. */
const MAX_OUTPUT_BYTES = 10 * 1024

/** Tool name substrings (case-insensitive) treated as file-writing tool calls. */
const WRITE_TOOL_HINTS = ["write"]
const EDIT_TOOL_HINTS = ["edit", "str_replace", "patch"]

export class GrokSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  /** Bounded tail of concatenated `type:"text"` chunks — the answer text. */
  private outputTail = ""

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    this.filesChanged = []
    this.outputTail = ""
    this.startedAt = Date.now()

    const args = ["--single", prompt, "--output-format", "streaming-json", "--always-approve"]

    // Containment for --always-approve comes from the OS sandbox wrapping
    // this spawn, not from trusting the flag itself. planSandboxedSpawn()
    // fails closed (throws) when no sandbox is available unless
    // SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: "grok",
        command: GROK_COMMAND,
        args,
        workspacePath: this.config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    this.process = spawn(plan.command, plan.args, {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("grok", this.config.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    await this.readStream()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return this.process.exitCode === null
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private readStream(): Promise<void> {
    return new Promise((resolve) => {
      const proc = this.process
      if (!proc?.stdout) {
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
          try {
            const event: unknown = JSON.parse(line)
            this.handleEvent(event)
          } catch {
            // Non-JSON stderr noise leaked onto stdout, or a partial line
          }
        }
      })

      proc.stdout.on("error", () => {
        // Stream error — proceed to close
      })

      proc.once("close", (code) => {
        const exitCode = code ?? -1

        if (exitCode !== 0) {
          this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `grok exited with code ${exitCode}`, exitCode !== 1)
        }

        resolve()
      })
    })
  }

  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>
    const type = typeof e.type === "string" ? e.type : undefined

    switch (type) {
      case "thought":
        // Reasoning/CoT — must not be concatenated into the final answer.
        // Emitted as a heartbeat so the orchestrator still sees liveness.
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        return

      case "text": {
        const data = typeof e.data === "string" ? e.data : undefined
        if (data) {
          // Stream per-chunk — the bounded tail (not full accumulation)
          // is what backs RunResult.output, keeping this OOM-safe.
          this.emit({ type: "output", chunk: data })
          this.appendOutputTail(data)
        }
        return
      }

      case "end":
        this.handleEnd(e)
        return

      default:
        // Tool-call shape unconfirmed — see module doc comment.
        if (type && isToolUseType(type)) {
          this.handleToolUse(e)
        }
    }
  }

  private appendOutputTail(chunk: string): void {
    this.outputTail += chunk
    if (this.outputTail.length > MAX_OUTPUT_BYTES) {
      this.outputTail = this.outputTail.slice(-MAX_OUTPUT_BYTES)
    }
  }

  private handleToolUse(e: Record<string, unknown>): void {
    const toolName =
      (e.name as string | undefined) ??
      (e.tool as string | undefined) ??
      ((e.function as Record<string, unknown> | undefined)?.name as string | undefined) ??
      "unknown"

    const rawInput = e.input ?? e.arguments ?? e.args ?? (e.function as Record<string, unknown> | undefined)?.arguments

    const input = normalizeToolInput(rawInput)

    this.emit({ type: "toolUse", tool: toolName, args: input ?? {} })

    const lowerName = toolName.toLowerCase()
    const isWrite = WRITE_TOOL_HINTS.some((hint) => lowerName.includes(hint))
    const isEdit = !isWrite && EDIT_TOOL_HINTS.some((hint) => lowerName.includes(hint))

    if (isWrite || isEdit) {
      const path =
        (input?.file_path as string | undefined) ??
        (input?.path as string | undefined) ??
        (input?.filePath as string | undefined)

      if (path && !this.filesChanged.includes(path)) {
        this.filesChanged.push(path)
        this.emit({
          type: "fileChange",
          path,
          changeType: isWrite ? "add" : "modify",
        })
      }
    }
  }

  private handleEnd(e: Record<string, unknown>): void {
    // Failure signal is unconfirmed against real output — see module doc
    // comment. Kept conservative: only an explicit `error`/`is_error`
    // field trips this; an unrecognized `stopReason` value is NOT
    // treated as an error (a non-"EndTurn" reason could just as well be
    // an intermediate multi-turn stop).
    const isError = e.error === true || (typeof e.error === "string" && e.error.length > 0) || e.is_error === true

    if (isError) {
      const message = typeof e.error === "string" ? e.error : "grok reported an error in the end event"
      this.emitError("CRASH", message, true)
      return
    }

    this.emit({
      type: "complete",
      result: {
        exitCode: 0,
        output: this.outputTail,
        durationMs: this.elapsedMs(),
        filesChanged: this.filesChanged,
        tokenUsage: this.extractTokenUsage(e),
      },
    })
  }

  private extractTokenUsage(
    endEvent: Record<string, unknown>,
  ): { input: number; output: number; model: string } | undefined {
    const usage = endEvent.usage as Record<string, unknown> | undefined
    if (!usage) return undefined

    const input = usage.input_tokens as number | undefined
    const output = usage.output_tokens as number | undefined
    if (input === undefined && output === undefined) return undefined

    const modelUsage = endEvent.modelUsage as Record<string, unknown> | undefined
    const model = modelUsage ? Object.keys(modelUsage)[0] : undefined

    return {
      input: input ?? 0,
      output: output ?? 0,
      model: model ?? this.config?.model ?? "grok",
    }
  }
}

// ── Event-shape helpers ─────────────────────────────────────────────────────

/** Tool-call type aliases — UNCONFIRMED, see module doc comment. */
function isToolUseType(type: string): boolean {
  return type === "tool_use" || type === "tool_call" || type === "function_call"
}

/** Tool input may already be an object, or a JSON-encoded string (seen in some agentic CLIs). */
function normalizeToolInput(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null) return undefined
  if (typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>
    } catch {
      // Not JSON — leave undefined
    }
  }
  return undefined
}
