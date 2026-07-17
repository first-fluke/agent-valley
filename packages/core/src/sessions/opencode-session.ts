/**
 * OpencodeSession — OpenCode CLI with streaming NDJSON output.
 *
 * Mode: opencode run "<prompt>" --format json --auto [--model <provider/model>]
 * Input: prompt passed as a guarded trailing positional argv element (Node
 *   spawn uses an argv array, not a shell, so this carries no shell-injection
 *   risk — same rationale as grok/kimi/cursor-session.ts). `opencode run`'s
 *   documented signature is `opencode run <message>`, a positional, not
 *   stdin, so the same length-guard technique as cursor-session.ts is used.
 *
 * // verified against `opencode --help`, `opencode run --help`, the official
 * // docs (opencode.ai/docs/cli), AND a real live invocation on this machine
 * // (opencode v1.17.18) that DID trigger the oma-backend Skill via a tool
 * // call — see the event-schema note below for exactly what that capture
 * // confirmed and what it did not.
 *
 * Confirmed flags:
 *   run <message>          non-interactive single-turn entry point, message
 *                           is a positional argument
 *   --format json           NDJSON event stream — USE this (not `default`,
 *                           which is human-formatted text)
 *   --auto                  "Auto-approve permissions that are not
 *                           explicitly denied" — the headless auto-approve
 *                           flag. Containment still comes from the OS
 *                           sandbox (planSandboxedSpawn), never from
 *                           trusting this flag, same as every other vendor.
 *   -m/--model <provider/model>   format is "provider/model", e.g.
 *                           "anthropic/claude-sonnet-5"
 *   --agent <name>, -c/--continue, -s/--session <id>   not used here (this
 *                           adapter is one-shot per execute(), like
 *                           claude/grok/kimi/cursor's stateless mode)
 *   --pure                  runs without external plugins — DELIBERATELY
 *                           NEVER PASSED. oma links `.opencode/plugins/oma/`
 *                           + `.opencode/agents/` into the project, and
 *                           opencode auto-discovers `.opencode/` + AGENTS.md
 *                           with no extra flag needed. Passing --pure would
 *                           disable the oma plugin surface entirely.
 *
 * No --skills-dir-equivalent flag exists or is needed: opencode auto-loads
 * `.opencode/` (agents/plugins) and AGENTS.md from the project root, same
 * auto-discovery model as kimi's `.agents/skills/` (see kimi-session.ts).
 *
 * Auth: `~/.local/share/opencode/auth.json` (populated by `opencode auth`)
 * plus provider env vars (e.g. ANTHROPIC_API_KEY) and the project `.env`.
 * There is no single OPENCODE_API_KEY. When unauthenticated / no provider
 * is configured, this adapter surfaces an actionable AUTH_FAILED error
 * naming `opencode auth`. The exact unauthenticated-run error text was NOT
 * captured live (the live run that produced the schema below was already
 * authenticated) — the detection regex below is a best-effort, UNVERIFIED
 * pattern match on common phrasing ("not authenticated", "no provider",
 * "run.*opencode auth", "unauthorized", "missing.*api key", "no
 * credentials"), mirroring kimi-session.ts's tolerant approach for the same
 * situation. Verify against a real unauthenticated run and tighten this
 * regex in a follow-up round.
 *
 * NDJSON event schema — PARTIALLY CONFIRMED by the live v1.17.18 capture
 * (raw file: see result-opencode-adapter.md for the capture excerpt). The
 * capture confirmed these `type` values appear on the wire, in this rough
 * order: `step-start` (also seen as `step_start` in the same capture —
 * both spellings are handled defensively, real cause unconfirmed: possibly
 * two distinct lifecycle events, possibly a snake/kebab inconsistency
 * between opencode versions/build), `tool_use` (this is how the run
 * invoked the oma-backend Skill — the tool name/args field names inside
 * this event were NOT resolvable from the capture, which only preserved
 * matched keyword lines, not full JSON), and `tool` (a tool-result event
 * following `tool_use`). The capture did NOT preserve a terminal
 * "final answer" event's exact shape, nor any token/usage field names —
 * those are UNVERIFIED and handled by a tolerant, best-effort parser
 * below, mirroring kimi-session.ts's approach for the same
 * not-fully-captured situation:
 *   - `step-start` / `step_start`: treated as a heartbeat (agent is alive,
 *     no text payload confirmed).
 *   - `tool_use`: emits a `toolUse` event. Tool name/args are extracted
 *     tolerantly from common aliases (name/tool/function.name,
 *     input/arguments/args/function.arguments), same alias set as
 *     grok-session.ts's `handleToolUse`, since the exact field names were
 *     not recoverable from the capture. write/edit-hinted tool names map
 *     to `fileChange` events, same convention as every other adapter.
 *   - `tool`: a tool-result event. Treated as a heartbeat by default; if it
 *     happens to carry a string `output`/`result`/`text` field (or
 *     `state.output`), that text is also emitted as an `output` chunk —
 *     best-effort, not confirmed.
 *   - Any other/unknown event type: tolerant flat-shape fallback, same
 *     pattern as kimi/cursor-session.ts — a string `text`/`content`/
 *     `delta`/`data` field directly on the event is emitted as an `output`
 *     chunk and appended to a bounded tail (last 10KB, see
 *     `appendOutputTail`), the same OOM-safe bounding grok-session.ts uses.
 *   - No terminal "result"/"finish" event shape was recoverable from the
 *     capture, so — unlike kimi/cursor, which complete on an explicit
 *     `result` event — completion here is driven by process exit
 *     (exitCode 0), same as grok-session.ts, using the bounded output tail
 *     built from streamed chunks as `RunResult.output`. IF a later capture
 *     confirms an explicit terminal event (e.g. `step-finish`/`finish`/
 *     `result`/`session.idle`) carrying its own final text and/or a
 *     `usage`/`tokens`/`cost` object, `handlePossibleTerminalEvent()`
 *     below opportunistically captures it (tolerant field-name aliases)
 *     and that text/usage — if present — takes priority over the
 *     accumulated tail when building the `complete` event, without
 *     requiring that event to be the actual process-exit trigger. Verify
 *     this against a real full-capture and tighten in a follow-up round.
 *
 * Tool-call event shape and terminal/result/usage field names are
 * therefore UNVERIFIED beyond the `type` values themselves — every
 * extraction below is deliberately tolerant/best-effort, not asserted as
 * confirmed schema.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv, waitForStreamCompletion } from "./base-session"
import { planSandboxedSpawn } from "./sandbox"

export const OPENCODE_COMMAND = "opencode"

/**
 * Max prompt length (chars) accepted as a positional argv element. Linux
 * execve() caps a single argv/envp string at MAX_ARG_STRLEN (128 KiB). This
 * guard stays well under that on every supported platform so a long
 * issue description fails fast with an actionable error instead of an
 * opaque `E2BIG` from the kernel. Same constant/rationale as
 * cursor-session.ts's MAX_PROMPT_ARG_LENGTH.
 */
export const MAX_PROMPT_ARG_LENGTH = 100_000

/** Max bytes of concatenated output-chunk text retained for RunResult.output. */
const MAX_OUTPUT_BYTES = 10 * 1024

/** Max bytes of raw stdout+stderr tail retained for unauth-message detection. */
const MAX_RAW_TAIL_BYTES = 4 * 1024

/** Tool name substrings (case-insensitive) treated as file-writing tool calls. */
const WRITE_TOOL_HINTS = ["write"]
const EDIT_TOOL_HINTS = ["edit", "str_replace", "patch"]

/** Best-effort, UNVERIFIED unauthenticated / no-provider error phrasing. */
const AUTH_FAILURE_PATTERN =
  /not authenticated|no provider|unauthorized|missing.*api.?key|no credentials|run\s+`?opencode auth`?/i

export class OpencodeSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  /** Bounded tail of streamed text chunks — backs RunResult.output when no explicit terminal event is seen. */
  private outputTail = ""
  /** Raw stdout+stderr tail, used only for AUTH_FAILED detection on non-zero exit. */
  private rawTail = ""
  /** Opportunistically captured from an unconfirmed terminal-shaped event, if one appears — see module doc comment. */
  private explicitResult: string | undefined
  private explicitTokenUsage: { input: number; output: number; model: string } | undefined

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    if (prompt.length > MAX_PROMPT_ARG_LENGTH) {
      this.emitError(
        "CRASH",
        `OpencodeSession.execute: prompt is ${prompt.length} chars, exceeds MAX_PROMPT_ARG_LENGTH (${MAX_PROMPT_ARG_LENGTH}).\n` +
          "  Fix: shorten the issue/prompt template before calling execute().",
        false,
      )
      return
    }

    this.filesChanged = []
    this.outputTail = ""
    this.rawTail = ""
    this.explicitResult = undefined
    this.explicitTokenUsage = undefined
    this.startedAt = Date.now()

    // `opencode run <message>` — message is a positional argv element, not
    // interpolated into a shell string (spawn() uses an argv array), so
    // this carries no shell-injection risk even though the prompt
    // originates from untrusted issue text.
    const args = ["run", prompt, "--format", "json", "--auto"]

    if (this.config.model) {
      args.push("--model", this.config.model)
    }

    // NO --pure here — see module doc comment: it would disable the oma
    // plugin surface (.opencode/plugins/oma/, .opencode/agents/) that
    // opencode otherwise auto-discovers.
    //
    // Containment for --auto comes from the OS sandbox wrapping this
    // spawn, not from trusting the flag itself. planSandboxedSpawn() fails
    // closed (throws) when no sandbox is available unless
    // SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: "opencode",
        command: OPENCODE_COMMAND,
        args,
        workspacePath: this.config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    this.process = spawn(plan.command, plan.args, {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("opencode", this.config.env) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    await this.readStream()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return this.process.exitCode === null
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) return

    const decoder = new TextDecoder()
    let buffer = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = decoder.decode(chunk, { stream: true })
      this.appendRawTail(text)
      buffer += text
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const event: unknown = JSON.parse(line)
          this.handleEvent(event)
        } catch {
          // Non-JSON stdout noise, or a partial line — still captured in
          // rawTail for the unauth-detection check below.
        }
      }
    })

    proc.stdout.on("error", () => {
      // Stream error — proceed to close
    })

    const stderrDecoder = new TextDecoder()
    proc.stderr?.on("data", (chunk: Buffer) => {
      this.appendRawTail(stderrDecoder.decode(chunk, { stream: true }))
    })

    // Gated on BOTH stdout 'end' and process 'close' — see
    // waitForStreamCompletion() doc comment (base-session.ts) for why
    // 'close' alone races the final buffered 'data' chunk on a
    // fast-exiting process.
    const { exitCode: code } = await waitForStreamCompletion(proc)
    const exitCode = code ?? -1

    if (exitCode !== 0) {
      if (AUTH_FAILURE_PATTERN.test(this.rawTail)) {
        this.emitError(
          "AUTH_FAILED",
          "opencode is not authenticated (no configured provider/credentials detected).\n" +
            "  Fix: run `opencode auth` to configure a provider, or set the relevant provider\n" +
            "  API key env var (e.g. ANTHROPIC_API_KEY) before Symphony runs opencode.\n" +
            "  Location: ~/.local/share/opencode/auth.json, or the orchestrator process environment.",
          false,
        )
        return
      }
      this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `opencode exited with code ${exitCode}`, exitCode !== 1)
      return
    }

    this.emit({
      type: "complete",
      result: {
        exitCode: 0,
        output: this.explicitResult ?? this.outputTail,
        durationMs: this.elapsedMs(),
        filesChanged: this.filesChanged,
        tokenUsage: this.explicitTokenUsage,
      },
    })
  }

  private appendRawTail(chunk: string): void {
    this.rawTail += chunk
    if (this.rawTail.length > MAX_RAW_TAIL_BYTES) {
      this.rawTail = this.rawTail.slice(-MAX_RAW_TAIL_BYTES)
    }
  }

  private appendOutputTail(chunk: string): void {
    this.outputTail += chunk
    if (this.outputTail.length > MAX_OUTPUT_BYTES) {
      this.outputTail = this.outputTail.slice(-MAX_OUTPUT_BYTES)
    }
  }

  /**
   * Tolerant dispatcher — only `step-start`/`step_start`, `tool_use`, and
   * `tool` are confirmed `type` values from the live capture (see module
   * doc comment). Everything else falls through to a flat-shape fallback.
   */
  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>
    const type = typeof e.type === "string" ? e.type : undefined

    switch (type) {
      case "step-start":
      case "step_start":
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        return

      case "tool_use":
        this.handleToolUse(e)
        return

      case "tool":
        this.handleToolResult(e)
        return

      default:
        this.handlePossibleTerminalEvent(e)
        this.handleFlatTextFallback(e)
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

  /** `tool` (tool-result) event — confirmed to occur, payload shape unconfirmed. */
  private handleToolResult(e: Record<string, unknown>): void {
    const state = e.state as Record<string, unknown> | undefined
    const text =
      (e.output as string | undefined) ??
      (e.result as string | undefined) ??
      (e.text as string | undefined) ??
      (state?.output as string | undefined)

    if (typeof text === "string" && text.length > 0) {
      this.emit({ type: "output", chunk: text })
      this.appendOutputTail(text)
      return
    }

    this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
  }

  /**
   * Flat-shape fallback for unconfirmed event types — mirrors
   * kimi/cursor-session.ts's tolerant fallback: a string text/content/delta/
   * data field directly on the event is streamed as output.
   */
  private handleFlatTextFallback(e: Record<string, unknown>): void {
    const text = e.text ?? e.content ?? e.delta ?? e.data
    if (typeof text === "string" && text.length > 0) {
      this.emit({ type: "output", chunk: text })
      this.appendOutputTail(text)
    }
  }

  /**
   * Opportunistic best-effort capture of a possible terminal/result-shaped
   * event, in case a future capture confirms one of these type names
   * (`finish`/`step-finish`/`result`/`session.idle`/`done`). NOT confirmed
   * against real output — see module doc comment. When present, the
   * captured text/usage take priority over the accumulated output tail /
   * absent tokenUsage in the `complete` event built at process exit.
   */
  private handlePossibleTerminalEvent(e: Record<string, unknown>): void {
    const type = typeof e.type === "string" ? e.type : undefined
    if (!type || !TERMINAL_TYPE_HINTS.has(type)) return

    const text = (e.result as string | undefined) ?? (e.text as string | undefined) ?? (e.output as string | undefined)
    if (typeof text === "string" && text.length > 0) {
      this.explicitResult = text.length > MAX_OUTPUT_BYTES ? text.slice(-MAX_OUTPUT_BYTES) : text
    }

    const usage =
      (e.usage as Record<string, unknown> | undefined) ??
      (e.tokens as Record<string, unknown> | undefined) ??
      (e.cost as Record<string, unknown> | undefined)
    if (!usage) return

    const input =
      (usage.input_tokens as number | undefined) ??
      (usage.inputTokens as number | undefined) ??
      (usage.promptTokens as number | undefined)
    const output =
      (usage.output_tokens as number | undefined) ??
      (usage.outputTokens as number | undefined) ??
      (usage.completionTokens as number | undefined)

    if (input === undefined && output === undefined) return

    const model =
      (e.model as string | undefined) ?? (usage.model as string | undefined) ?? this.config?.model ?? "opencode"

    this.explicitTokenUsage = { input: input ?? 0, output: output ?? 0, model }
  }
}

/** Type names treated as a possible (UNCONFIRMED) terminal/result event — see handlePossibleTerminalEvent. */
const TERMINAL_TYPE_HINTS = new Set(["finish", "step-finish", "step_finish", "result", "session.idle", "done"])

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
