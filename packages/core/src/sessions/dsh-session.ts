import type { AgentConfig } from "./agent-session"
import { ClaudeSession } from "./claude-session"
import { exhaustionMessage, nativeErrorMessage } from "./native-failure"

/** Native headless JSON projection; only the spawn/stream transport is shared with Claude.
 * Protocol: deepseek-ai/deepseek-harness packages/bundle/headless/src/{startup,json-stream}.ts.
 */
export class DshSession extends ClaudeSession {
  protected override readonly vendor = "dsh"
  private sessionId: string | undefined
  private finalEvent: Record<string, unknown> | undefined
  private failed = false
  private cancelled = false
  private usageComplete = true
  private steps = 0
  private input = 0
  private output = 0

  override async start(config: AgentConfig): Promise<void> {
    if (config.model) {
      throw new Error(
        "DSH headless has no per-invocation model flag. Remove actor.model for dsh in av.yaml/settings.yaml and configure the DSH headless profile's native model route.",
      )
    }
    await super.start(config)
  }

  protected override buildArgs(): string[] {
    // The outer AV OS sandbox owns containment, just as for Claude's permission bypass.
    return [
      "--profile",
      "headless",
      "--json",
      "--permission-mode",
      "danger-full-access",
      "--approval-policy",
      "never",
      "-",
    ]
  }

  protected override resetNativeState(): void {
    this.sessionId = undefined
    this.finalEvent = undefined
    this.failed = false
    this.cancelled = false
    this.usageComplete = true
    this.steps = 0
    this.input = 0
    this.output = 0
  }

  override async cancel(): Promise<void> {
    this.cancelled = true
    await super.cancel()
  }

  override async kill(): Promise<void> {
    this.cancelled = true
    await super.kill()
  }

  protected override handleEvent(event: unknown): void {
    if (this.terminalEventReceived || !event || typeof event !== "object" || Array.isArray(event)) return
    const value = event as Record<string, unknown>
    if (value.type === "session") {
      if (this.sessionId !== undefined || typeof value.sessionId !== "string" || !value.sessionId) this.failed = true
      else this.sessionId = value.sessionId
      return
    }
    if (value.type === "error") {
      this.failed = true
      this.nativeError = exhaustionMessage(nativeErrorMessage(value, ""))
      return
    }
    if (value.type === "final") {
      if (this.finalEvent) this.failed = true
      this.finalEvent = value
      return
    }
    if (this.finalEvent) return
    if (value.type === "text" && typeof value.text === "string") {
      this.emit({ type: "output", chunk: value.text })
    } else if (value.type === "tool_call" && typeof value.tool === "string") {
      const args = value.input
      this.emit({
        type: "toolUse",
        tool: value.tool,
        args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {},
      })
    } else if (value.type === "status" && value.phase === "step_end") {
      this.steps++
      const usage = value.usage as Record<string, unknown> | undefined
      const input = usage?.inputTokens
      const output = usage?.outputTokens
      if (
        value.truncated === true ||
        typeof input !== "number" ||
        !Number.isSafeInteger(input) ||
        input < 0 ||
        typeof output !== "number" ||
        !Number.isSafeInteger(output) ||
        output < 0 ||
        !Number.isSafeInteger(this.input + input) ||
        !Number.isSafeInteger(this.output + output)
      )
        this.usageComplete = false
      else {
        // Native inputTokens already includes cache reads; optional cache buckets are subsets.
        this.input += input
        this.output += output
      }
    }
    this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
  }

  protected override finalizeNativeExit(code: number | null): void {
    if (this.terminalEventReceived) return
    const reason = this.finalEvent?.reason as Record<string, unknown> | undefined
    const tokenUsage =
      this.usageComplete && this.steps > 0
        ? { input: this.input, output: this.output, model: "dsh-native-route" }
        : undefined
    if (
      !this.cancelled &&
      !this.failed &&
      code === 0 &&
      this.sessionId !== undefined &&
      this.finalEvent?.sessionId === this.sessionId &&
      reason?.kind === "completed" &&
      typeof this.finalEvent.text === "string"
    ) {
      this.emit({
        type: "complete",
        result: {
          exitCode: 0,
          output: this.finalEvent.text.slice(-10_240),
          durationMs: this.elapsedMs(),
          filesChanged: [],
          tokenUsage,
        },
      })
      return
    }
    this.emit({
      type: "error",
      error: {
        code: code === null ? "TIMEOUT" : "CRASH",
        message:
          this.nativeError ??
          exhaustionMessage(nativeErrorMessage(reason, "")) ??
          "DSH did not complete a matching headless run. Check DEEPSEEK_API_KEY, update @deepseek-ai/dsh for headless --json support, and inspect the native headless profile before retrying.",
        exitCode: code ?? undefined,
        recoverable: false,
        tokenUsage,
      },
    })
  }
}
