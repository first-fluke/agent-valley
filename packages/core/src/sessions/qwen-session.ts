import { ClaudeSession } from "./claude-session"
import { exhaustionMessage, nativeErrorMessage } from "./native-failure"

// Qwen Code 0.20.1's native Computer Use catalog. Built-in deny rules require
// exact names: `computer_use__*` does not prevent registration or execution.
const computerUseTools = [
  "bring_to_front",
  "check_for_update",
  "check_permissions",
  "click",
  "double_click",
  "drag",
  "end_session",
  "get_accessibility_tree",
  "get_agent_cursor_state",
  "get_config",
  "get_cursor_position",
  "get_recording_state",
  "get_screen_size",
  "get_window_state",
  "hotkey",
  "kill_app",
  "launch_app",
  "list_apps",
  "list_windows",
  "move_cursor",
  "page",
  "press_key",
  "replay_trajectory",
  "right_click",
  "scroll",
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_style",
  "set_config",
  "set_value",
  "start_recording",
  "start_session",
  "stop_recording",
  "type_text",
  "zoom",
].map((name) => `computer_use__${name}`)

/** Qwen Code's documented Claude-compatible JSONL envelopes, with Qwen usage/error semantics.
 * https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/
 * Wire source: QwenLM/qwen-code packages/cli/src/nonInteractive/{types,io/BaseJsonOutputAdapter}.ts
 * Single-shot stdin mode deliberately avoids the evolving bidirectional SDK control protocol.
 */
export class QwenSession extends ClaudeSession {
  protected override readonly vendor = "qwen"
  private actualModel: string | undefined
  private usageModels = new Set<string>()
  private resultEvent: Record<string, unknown> | undefined
  private cancelled = false

  protected override buildArgs(): string[] {
    const args = ["--output-format", "stream-json", "--yolo"]
    // Only trusted native configuration may opt in; OS consent remains native.
    const purpose = this.config?.options?.computerUsePurpose
    if (typeof purpose !== "string" || !purpose.trim()) args.push("--exclude-tools", computerUseTools.join(","))
    if (this.config?.model) args.push("--model", this.config.model)
    return args
  }

  protected override resetNativeState(): void {
    this.actualModel = undefined
    this.usageModels.clear()
    this.resultEvent = undefined
    this.cancelled = false
  }

  override async cancel(): Promise<void> {
    this.cancelled = true
    await super.cancel()
  }

  override async kill(): Promise<void> {
    this.cancelled = true
    await super.kill()
  }

  override isAlive(): boolean {
    return this.config !== null && super.isAlive()
  }

  protected override fileChangeType(tool: string): "add" | "modify" | undefined {
    return tool === "write_file" ? "add" : tool === "edit" || tool === "replace" ? "modify" : undefined
  }

  protected override handleEvent(event: unknown): void {
    if (this.terminalEventReceived || !event || typeof event !== "object" || Array.isArray(event)) return
    const value = event as Record<string, unknown>
    const main = value.parent_tool_use_id == null
    if (main && value.type === "system" && typeof value.model === "string") this.actualModel = value.model
    if (value.type === "assistant") {
      const message = value.message as Record<string, unknown> | undefined
      if (typeof message?.model === "string") {
        this.usageModels.add(message.model)
        if (main) this.actualModel = message.model
      }
    }
    if (value.type === "result") {
      // A native subagent result must never finish the enclosing Chief/Actor run.
      if (!main) return
      if (value.is_error === true || String(value.subtype).startsWith("error")) {
        this.resultEvent = value
        return
      }
      if (value.is_error !== false || value.subtype !== "success" || typeof value.result !== "string") {
        this.emitError("CRASH", "Qwen Code returned an invalid result envelope. Update Qwen Code and retry.", false)
        return
      }
      // Exit code is authoritative even if a success envelope preceded a process failure.
      this.resultEvent = value
      return
    }
    if (value.type === "stream_event" || value.type === "user") {
      this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
      return
    }
    super.handleEvent(value)
  }

  protected override finalizeNativeExit(code: number | null): void {
    if (this.terminalEventReceived) return
    if (this.cancelled) {
      this.emit({
        type: "error",
        error: {
          code: "CRASH",
          message: "Qwen Code execution was cancelled. Start a new run to continue.",
          recoverable: false,
          tokenUsage: this.resultEvent ? this.extractTokenUsage(this.resultEvent) : undefined,
        },
      })
      return
    }
    if (
      this.resultEvent &&
      (this.resultEvent.is_error === true || String(this.resultEvent.subtype).startsWith("error"))
    ) {
      this.emit({
        type: "error",
        error: {
          code: "CRASH",
          message:
            exhaustionMessage(nativeErrorMessage([this.resultEvent, this.nativeError], "")) ??
            "Qwen Code reported a failed run. Check qwen /auth, model access and limits, then retry av order.",
          recoverable: false,
          tokenUsage: this.extractTokenUsage(this.resultEvent),
        },
      })
      return
    }
    if (code === 0 && this.resultEvent) super.handleEvent(this.resultEvent)
    else if (this.resultEvent)
      this.emit({
        type: "error",
        error: {
          code: "CRASH",
          message: this.nativeError ?? "Qwen Code failed after its result. Run av doctor and retry.",
          recoverable: false,
          tokenUsage: this.extractTokenUsage(this.resultEvent),
        },
      })
    else super.finalizeNativeExit(code)
  }

  protected override extractTokenUsage(
    event: Record<string, unknown>,
  ): { input: number; output: number; model: string } | undefined {
    const usage = event.usage as Record<string, unknown> | undefined
    const input = usage?.input_tokens
    const output = usage?.output_tokens
    if (
      typeof input !== "number" ||
      typeof output !== "number" ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input < 0 ||
      output < 0
    )
      return
    // Qwen's input_tokens is already totalPromptTokens; cached input is a subset, not an extra billable count.
    const models = Object.keys(event.modelUsage && typeof event.modelUsage === "object" ? event.modelUsage : {})
    const mixed = models.length > 1 || this.usageModels.size > 1
    const model = mixed ? "qwen-mixed-models" : (this.actualModel ?? models[0] ?? this.config?.model ?? "qwen")
    return { input, output, model }
  }
}
