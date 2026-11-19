/**
 * AgyLiveRun — one Antigravity run that keeps taking messages on stdin.
 *
 * Verified against agy v1.5.12: print mode with `--input-format stream-json
 * --output-format stream-json` keeps stdin open, reads one
 * `{"event":"user","message":{"role":"user","content":…}}` line per message
 * and runs a turn for each. A message written while a turn runs is taken when
 * that turn ends, as a follow-up turn in the same conversation.
 *
 * Stdout carries `init`, `step_update` (user_input, agent_response with
 * `text_delta`, tool with `tool_name` and `tool_info.parameters`) and one
 * `result` per turn, whose `usage` is cumulative for the process. A result is
 * only emitted after the turn's background commands finish, which `agy acp`
 * does not guarantee — that is why this mode, not ACP, drives live runs.
 *
 * The session owns the process; this class owns the protocol.
 */

import type { Writable } from "node:stream"
import { exhaustionMessage } from "./native-failure"
import { MAX_NATIVE_RESULT_LENGTH, nativeResultLimitMessage } from "./native-result"
import { QueuedMessages } from "./queued-messages"

type Json = Record<string, unknown>
type TokenUsage = { input: number; output: number; model: string }

export interface AgyLiveEvents {
  output(chunk: string): void
  toolUse(tool: string, args: Json): void
  fileChange(path: string, changeType: "add" | "modify"): void
  /** Proof of life that carries nothing to show. */
  activity(): void
  /** The run finished; the session should close stdin so the process exits. */
  complete(result: { output: string; filesChanged: string[]; tokenUsage: TokenUsage | undefined }): void
  failed(message: string, recoverable: boolean): void
}

export interface AgyLiveOptions {
  /** Configured model, reported with usage when agy does not name one. */
  model?: string
  /** How long a finished turn waits for agy to take a message queued behind it. */
  graceMs: number
  events: AgyLiveEvents
}

/** Tools that create a file, and tools that change one; both name it in `Path`. */
const CREATING_TOOLS = new Set(["write_file", "write_to_file"])
const EDITING_TOOLS = new Set(["edit_file", "replace_file_content", "multi_replace_file_content", "sed_file"])

export class AgyLiveRun {
  /** True once agy emitted any stream event, i.e. it understands this mode. */
  sawEvent = false
  private ended = false
  private streamModel: string | undefined
  private usage: TokenUsage | undefined
  private filesChanged: string[] = []
  private reportedSteps = new Set<number>()
  private readonly queue: QueuedMessages

  constructor(
    private readonly stdin: Writable | null | undefined,
    private readonly options: AgyLiveOptions,
  ) {
    this.queue = new QueuedMessages(
      () => options.graceMs,
      () => this.complete(""),
    )
  }

  /** Write the task or an operator message. Rejects when the run cannot take it. */
  async send(text: string): Promise<void> {
    if (this.ended) {
      throw new Error("agy is not accepting messages (the run has ended). Restart the run with the message instead.")
    }
    const message = { event: "user", message: { role: "user", content: text } }
    await this.queue.write(this.stdin, crypto.randomUUID(), message, "agy")
  }

  handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Json
    this.sawEvent = true
    // Any event after a held result means agy is working through its queue.
    this.queue.activity()

    if (e.event === "step_update" && typeof e.step_update === "object" && e.step_update !== null) {
      this.handleStep(e.step_update as Json)
    } else if (e.event === "result" && typeof e.result === "object" && e.result !== null) {
      this.handleResult(e.result as Json)
    } else {
      const init = e.init as Json | undefined
      if (typeof init?.model === "string") this.streamModel = init.model
      this.options.events.activity()
    }
  }

  /**
   * The process exited. A clean exit with a turn still held back completes the
   * run with that turn; returns whether a terminal event was emitted here.
   */
  processExited(code: number | null): boolean {
    this.queue.activity()
    if (this.ended) return true
    if (code === 0 && this.queue.holding) {
      this.complete("")
      return true
    }
    this.ended = true
    return false
  }

  private handleStep(step: Json): void {
    const { events } = this.options
    if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
      events.output(step.text_delta)
      return
    }
    // agy reports the user step when it takes a message off its queue.
    if (step.step_type === "user_input" && step.state === "DONE") this.queue.taken()
    if (step.step_type === "tool" && typeof step.step_index === "number" && !this.reportedSteps.has(step.step_index)) {
      this.reportedSteps.add(step.step_index)
      const info = step.tool_info as Json | undefined
      const tool = typeof step.tool_name === "string" ? step.tool_name : String(info?.name ?? "unknown")
      const args = info?.parameters && typeof info.parameters === "object" ? (info.parameters as Json) : {}
      events.toolUse(tool, args)
      const changeType = CREATING_TOOLS.has(tool) ? "add" : EDITING_TOOLS.has(tool) ? "modify" : undefined
      if (changeType && typeof args.Path === "string" && !this.filesChanged.includes(args.Path)) {
        this.filesChanged.push(args.Path)
        events.fileChange(args.Path, changeType)
      }
      return
    }
    events.activity()
  }

  private handleResult(result: Json): void {
    const usage = result.usage as Json | undefined
    if (typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number") {
      // Cumulative for the process, so the latest result replaces earlier ones. Cache reads are counted apart.
      const cached = typeof usage.cache_read_tokens === "number" ? usage.cache_read_tokens : 0
      this.usage = {
        input: usage.input_tokens + cached,
        output: usage.output_tokens,
        model: this.options.model ?? this.streamModel ?? "antigravity",
      }
    }
    const response = typeof result.response === "string" ? result.response : ""
    if (result.status !== "SUCCESS") {
      const reason = typeof result.error === "string" && result.error ? result.error : `status ${String(result.status)}`
      this.ended = true
      this.queue.activity()
      this.options.events.failed(
        exhaustionMessage(reason) ?? `agy reported a failed turn: ${reason.slice(0, 10_240)}`,
        true,
      )
    } else if (this.queue.pending) {
      // A message is queued behind this turn: agy answers it in a follow-up turn with its own result.
      this.queue.hold(response)
    } else {
      this.complete(response)
    }
  }

  /** Finish the run with this turn's response plus any turns held back before it. */
  private complete(response: string): void {
    if (this.ended) return
    this.ended = true
    const output = [...this.queue.release(), response]
      .map((part) => part.trim())
      .filter(Boolean)
      .join("\n\n")
    if (output.length > MAX_NATIVE_RESULT_LENGTH) {
      this.options.events.failed(nativeResultLimitMessage("Antigravity"), false)
    } else {
      this.options.events.complete({ output, filesChanged: this.filesChanged, tokenUsage: this.usage })
    }
  }
}
