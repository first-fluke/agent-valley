/**
 * Grok headless Messages stream. `result.result` contains the final assistant
 * text; earlier assistant messages remain live progress output. Reading their
 * concatenation as a JSON decision corrupts otherwise valid native responses.
 *
 * The installed Grok headless protocol documents `streaming-messages-json`
 * assistant, user/tool-result and terminal result frames. Token usage is read
 * once from the terminal aggregate, including the reported actual model.
 * Legacy thought/text/end events remain readable; thought text is never output.
 *
 * The prompt is an argv value, and --always-approve runs inside the OS sandbox.
 * Model selection retains the existing CLI configuration behavior.
 */

import type { AgentConfig } from "./agent-session"
import { BaseSession, waitForStreamCompletion } from "./base-session"
import { readJsonLines } from "./json-lines"
import { captureExhaustion, nativeErrorMessage } from "./native-failure"

export const GROK_COMMAND = "grok"

/** Max bytes of concatenated answer text retained for RunResult.output. */
const MAX_OUTPUT_BYTES = 10 * 1024
const MAX_RESULT_LENGTH = 256_000

/** Tool name substrings (case-insensitive) treated as file-writing tool calls. */
const WRITE_TOOL_HINTS = ["write"]
const EDIT_TOOL_HINTS = ["edit", "str_replace", "patch"]

export class GrokSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false
  /** Bounded tail of concatenated `type:"text"` chunks — the answer text. */
  private outputTail = ""
  private stderrExhaustion?: () => string | undefined

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
    this.stderrExhaustion = undefined
    this.startedAt = Date.now()

    const args = ["--single", prompt, "--output-format", "streaming-messages-json", "--always-approve"]

    // Containment for --always-approve comes from the OS sandbox wrapping
    // this spawn, not from trusting the flag itself. spawnSandboxed() fails
    // closed when no sandbox is available unless SYMPHONY_ALLOW_UNSANDBOXED=1.
    const spawned = await this.spawnSandboxed({
      agentType: "grok",
      command: GROK_COMMAND,
      args,
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (!spawned) return
    this.stderrExhaustion = captureExhaustion(this.process?.stderr)

    await this.readStream()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started && this.config !== null
    return super.isAlive()
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) return
    const flush = readJsonLines(proc.stdout, (event) => this.handleEvent(event))
    const { exitCode: code } = await waitForStreamCompletion(proc)
    flush()
    if (this.terminalEventReceived) return
    const exitCode = code ?? -1
    this.emitError(
      exitCode === -1 ? "TIMEOUT" : "CRASH",
      this.stderrExhaustion?.() ??
        (exitCode === 0
          ? "grok exited without a result event. Check CLI authentication and update Grok, then retry."
          : `grok exited with code ${exitCode}. Run av doctor and check Grok authentication.`),
      exitCode !== 1,
    )
  }

  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>
    const type = typeof e.type === "string" ? e.type : undefined

    switch (type) {
      case "assistant": {
        const message = e.message as { content?: Array<Record<string, unknown>> } | undefined
        for (const block of message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") this.emit({ type: "output", chunk: block.text })
          else if (block.type === "tool_use") this.handleToolUse(block)
        }
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        return
      }

      case "result":
        this.handleResult(e)
        return

      case "error":
        this.emitError("CRASH", nativeErrorMessage(e, "Grok reported an error"), true)
        return

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

  private handleResult(e: Record<string, unknown>): void {
    const stop = typeof e.stop_reason === "string" ? e.stop_reason : undefined
    if (
      e.is_error === true ||
      (typeof e.subtype === "string" && e.subtype !== "success") ||
      (stop && stop !== "end_turn" && stop !== "stop_sequence")
    ) {
      this.emitError(
        "CRASH",
        nativeErrorMessage(
          { errors: e.errors, error: e.error },
          `Grok did not complete: ${stop ?? e.subtype}. Inspect the failed run before retrying.`,
        ),
        true,
      )
      return
    }
    if (typeof e.result !== "string") {
      this.emitError(
        "CRASH",
        "Grok result has no final answer text. Update Grok and inspect its native result before retrying.",
        false,
      )
      return
    }
    if (e.result.length > MAX_RESULT_LENGTH) {
      this.emitError(
        "CRASH",
        "Grok final answer exceeds 256000 characters. Return a smaller response and write large deliverables to files.",
        false,
      )
      return
    }
    this.emit({
      type: "complete",
      result: {
        exitCode: 0,
        output: e.result,
        durationMs: this.elapsedMs(),
        filesChanged: this.filesChanged,
        tokenUsage: this.extractTokenUsage(e),
      },
    })
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
