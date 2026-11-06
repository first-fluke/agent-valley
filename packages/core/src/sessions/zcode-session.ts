import type { AgentConfig } from "./agent-session"
import { BaseSession, waitForStreamCompletion } from "./base-session"
import { readJsonLines } from "./json-lines"
import { captureExhaustion, exhaustionMessage, nativeErrorMessage } from "./native-failure"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Native ZCode CLI protocol, not Claude's stream-json format.
 * Source: zai-org/ZCode apps/zcode-cli/packages/cli/src/prompt-command.ts and
 * packages/bootstrap/src/zcode-protocol/session-mapper.ts (2026-11-06).
 */
export class ZcodeSession extends BaseSession {
  private result: Record<string, unknown> | undefined
  private cancelled = false
  private sessionId: string | undefined
  private failure: string | undefined
  private models = new Set<string>()
  private nestedUsage = false
  private tools = new Map<string, { name: string; args: Record<string, unknown> }>()
  private filesChanged: string[] = []

  async start(config: AgentConfig): Promise<void> {
    this.config = config
  }

  override isAlive(): boolean {
    return this.config !== null && (this.process ? super.isAlive() : true)
  }

  async execute(prompt: string): Promise<void> {
    if (!this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }
    if (this.config.model) {
      this.emitError(
        "CRASH",
        "ZCode CLI does not support a per-run --model flag. Configure defaultModelSelection in ~/.zcode/v2/provider_config.json (under ZCODE_DATA_BASE_DIR when set) and remove actor.model from av.yaml or settings.yaml.",
        false,
      )
      return
    }
    this.result = undefined
    this.cancelled = false
    this.sessionId = undefined
    this.failure = undefined
    this.models.clear()
    this.nestedUsage = false
    this.tools.clear()
    this.filesChanged = []
    this.startedAt = Date.now()
    // Native prompt mode accepts argv only. No shell is involved. Browser mode
    // remains opt-in in the native CLI; this adapter does not download a browser.
    const spawned = await this.spawnSandboxed({
      agentType: "zcode",
      command: "zcode",
      args: ["--prompt", prompt, "--mode", "yolo", "--output-format", "stream-json", "--no-color"],
      stdio: ["ignore", "pipe", "pipe"],
    })
    if (!spawned || !this.process?.stdout) return
    const stderrFailure = captureExhaustion(this.process.stderr)
    const flush = readJsonLines(this.process.stdout, (event) => this.handleEvent(event))
    const { exitCode } = await waitForStreamCompletion(this.process)
    flush()
    this.finish(exitCode, stderrFailure())
  }

  private finish(exitCode: number | null, stderrFailure: string | undefined): void {
    if (this.terminalEventReceived) return
    const result = this.result
    const valid =
      result &&
      typeof result.sessionId === "string" &&
      typeof result.response === "string" &&
      record(result.projection).status === "idle"
    const tokenUsage = this.tokenUsage()
    if (this.cancelled || exitCode !== 0 || this.failure || !valid) {
      this.emit({
        type: "error",
        error: {
          code: exitCode === null ? "TIMEOUT" : "CRASH",
          message:
            stderrFailure ??
            exhaustionMessage(this.failure ?? "") ??
            "ZCode did not finish with a valid result. Run zcode login, check ~/.zcode/v2/provider_config.json, and update the native Agent CLI before retrying.",
          recoverable: false,
          tokenUsage,
        },
      })
      return
    }
    this.emit({
      type: "complete",
      result: {
        exitCode: 0,
        output: (result.response as string).slice(-10_240),
        durationMs: this.elapsedMs(),
        filesChanged: this.filesChanged,
        tokenUsage,
      },
    })
  }

  private handleEvent(event: unknown): void {
    const value = record(event)
    const payload = record(value.payload)
    if (typeof value.type !== "string" || this.terminalEventReceived) return
    if (typeof value.sessionId === "string") {
      if (this.sessionId && this.sessionId !== value.sessionId) return
      this.sessionId = value.sessionId
    }
    this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
    if (value.type === "result") {
      if (this.result) this.failure = "ZCode emitted duplicate result envelopes"
      else this.result = value
    } else if (value.type === "model.streaming" && payload.kind === "text_delta" && typeof payload.delta === "string") {
      this.emit({ type: "output", chunk: payload.delta })
    } else if (value.type === "session.updated") {
      if (typeof payload.modelId === "string") this.models.add(payload.modelId)
      // Native ModelComplete for tool-internal model calls is mapped unchanged
      // to session.updated. Its usage joins the turn aggregate without a model ID.
      if (payload.stopReason === "tool_internal") this.nestedUsage = true
    } else if (value.type === "turn.failed") {
      this.failure = nativeErrorMessage(payload, "ZCode turn failed")
    } else if (value.type === "turn.completed" && payload.resultType !== "success") {
      this.failure = `ZCode turn ${String(payload.resultType)}`
    } else if (value.type === "tool.updated") {
      const id = payload.toolCallId
      if (typeof id !== "string") return
      if (payload.kind === "scheduled" && typeof payload.toolName === "string") {
        const args = record(payload.input)
        this.tools.set(id, { name: payload.toolName, args })
        this.emit({ type: "toolUse", tool: payload.toolName, args })
      } else if (payload.kind === "result" && record(payload.result).success === true) {
        const tool = this.tools.get(id)
        this.tools.delete(id)
        if (!tool || !["Write", "Edit"].includes(tool.name)) return
        const path = tool.args.file_path
        if (typeof path !== "string" || this.filesChanged.includes(path)) return
        this.filesChanged.push(path)
        this.emit({ type: "fileChange", path, changeType: tool.name === "Write" ? "add" : "modify" })
      } else if (payload.kind === "error") {
        this.tools.delete(id)
      }
    }
  }

  override async cancel(): Promise<void> {
    this.cancelled = true
    await super.cancel()
  }

  override async kill(): Promise<void> {
    this.cancelled = true
    await super.kill()
  }

  private tokenUsage(): { input: number; output: number; model: string } | undefined {
    const usage = record(this.result?.usage)
    if (usage.source !== "provider") return
    const input = usage.inputTokens
    const output = usage.outputTokens
    if (
      typeof input !== "number" ||
      typeof output !== "number" ||
      !Number.isSafeInteger(input) ||
      !Number.isSafeInteger(output) ||
      input < 0 ||
      output < 0
    )
      return
    // Native inputTokens already includes cached input. Aggregate usage can
    // include several requests/models; never guess a cost model from config.
    return {
      input,
      output,
      model:
        (!this.nestedUsage && this.models.size === 1 ? [...this.models][0] : undefined) ?? "zcode-mixed-or-unknown",
    }
  }
}
