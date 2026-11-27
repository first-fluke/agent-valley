/**
 * ClaudeSession — Claude Code with streaming NDJSON output.
 *
 * Mode: claude --print --output-format stream-json
 * Input: prompt passed via stdin as plain text
 * Output: NDJSON lines — system init, assistant messages, tool use, result
 *
 * Note: Claude Code is NOT a persistent server. Each execute() spawns a new process.
 * The "session" manages process lifecycle and event normalization.
 *
 * Live input (`options.liveInput`): stdin stays open as an NDJSON stream
 * (`--input-format stream-json`), so `sendUserMessage()` reaches the running
 * process. Claude picks a queued message up at its next tool boundary, or as a
 * follow-up turn when the current one has already ended. The wire format is
 * the Agent SDK's streaming-input protocol (SDKUserMessage in,
 * SDKUserMessageReplay and SDKResultMessage out):
 * https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode
 */

import { randomUUID } from "node:crypto"
import type { AgentConfig } from "./agent-session"
import { BaseSession, waitForStreamCompletion } from "./base-session"
import { type ClaudeLoginKeeper, keepClaudeLoginFresh } from "./claude-login"
import { readJsonLines } from "./json-lines"
import { captureExhaustion } from "./native-failure"
import { MAX_NATIVE_RESULT_LENGTH, nativeResultLimitMessage } from "./native-result"
import { QUEUED_MESSAGE_GRACE_MS, QueuedMessages } from "./queued-messages"
import type { SandboxSpawnPlan } from "./sandbox"

export const CLAUDE_KEEP_MCP_ENV = "AV_CLAUDE_KEEP_MCP"
export const CLAUDE_KEEP_HOOKS_ENV = "AV_CLAUDE_KEEP_HOOKS"
const CLAUDE_DISABLE_HOOKS_SETTINGS = '{"disableAllHooks":true}'

type TokenUsage = { input: number; output: number; model: string }

export class ClaudeSession extends BaseSession {
  protected filesChanged: string[] = []
  protected readonly vendor: string = "claude"
  private started = false
  protected nativeError: string | undefined
  private liveInput = false
  protected queuedMessageGraceMs = QUEUED_MESSAGE_GRACE_MS
  /** Messages written to stdin, and the turns that ended while one was still waiting. */
  private readonly queue = new QueuedMessages(
    () => this.queuedMessageGraceMs,
    () => this.completeRun("", {}),
  )
  /** Usage of the turns held in the queue; Claude reports it per turn. */
  private heldUsage: TokenUsage | undefined
  /** Refreshes the stored subscription login from the host while a Seatbelt session runs. */
  private loginKeeper: ClaudeLoginKeeper | undefined

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.started = true
  }

  protected buildArgs(): string[] {
    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ]

    // Isolate headless Claude runs from ambient MCP servers and interactive PreToolUse hooks
    // (which fail inside Seatbelt and can block native Grep/Glob/Bash). Gated strictly to
    // Claude so subclasses (QwenSession, DshSession) never inherit Claude-specific flags.
    if (this.vendor === "claude") {
      const keepMcp =
        this.config?.options?.keepMcp === true ||
        (this.config?.env?.[CLAUDE_KEEP_MCP_ENV] ?? process.env[CLAUDE_KEEP_MCP_ENV]) === "1"
      if (!keepMcp) {
        args.push("--strict-mcp-config")
      }

      const keepHooks =
        this.config?.options?.keepHooks === true ||
        (this.config?.env?.[CLAUDE_KEEP_HOOKS_ENV] ?? process.env[CLAUDE_KEEP_HOOKS_ENV]) === "1"
      if (!keepHooks) {
        args.push("--settings", CLAUDE_DISABLE_HOOKS_SETTINGS)
      }
    }

    if (this.config?.model) {
      args.push("--model", this.config?.model)
    }

    const effort = this.config?.options?.effort as string | undefined
    if (effort) {
      args.push("--effort", effort)
    }

    if (this.liveInputRequested()) {
      args.push("--input-format", "stream-json", "--replay-user-messages")
    }

    return args
  }

  /** Subclasses reuse this transport for other CLIs, which only take a one-shot stdin prompt. */
  private liveInputRequested(): boolean {
    return this.vendor === "claude" && this.config?.options?.liveInput === true
  }

  protected resetNativeState(): void {}

  protected fileChangeType(tool: string): "add" | "modify" | undefined {
    return tool === "Write" ? "add" : tool === "Edit" ? "modify" : undefined
  }

  async execute(prompt: string): Promise<void> {
    if (!this.started || !this.config) {
      this.emitError("CRASH", "execute() called before start()", false)
      return
    }

    this.filesChanged = []
    this.nativeError = undefined
    this.resetNativeState()
    this.startedAt = Date.now()
    this.liveInput = this.liveInputRequested()
    this.queue.reset()
    this.heldUsage = undefined

    const args = this.buildArgs()
    // Containment for --dangerously-skip-permissions comes from the OS
    // sandbox wrapping this spawn, not from trusting the flag itself.
    // spawnSandboxed() fails closed when no sandbox is available unless
    // SYMPHONY_ALLOW_UNSANDBOXED=1 is set. The prompt goes through stdin to
    // avoid arg length/injection issues.
    const spawned = await this.spawnSandboxed({
      agentType: this.vendor,
      command: this.vendor,
      args,
      stdio: ["pipe", "pipe", "pipe"],
      prompt: this.liveInput ? undefined : prompt,
    })
    if (!spawned) return this.stopLoginKeeper()
    // A prompt that cannot be written means the process is already gone; its exit reports the failure.
    if (this.liveInput) this.writeUserMessage(prompt).catch(() => {})

    try {
      await this.readStream()
    } finally {
      this.stopLoginKeeper()
    }
  }

  /** A Seatbelt session cannot store a refreshed login in the keychain; see claude-login.ts. */
  protected override async beforeSpawn(plan: SandboxSpawnPlan, env: NodeJS.ProcessEnv): Promise<void> {
    this.stopLoginKeeper()
    if (this.vendor !== "claude" || !plan.sandboxed || plan.platform !== "darwin") return
    this.loginKeeper = keepClaudeLoginFresh(env)
    await this.loginKeeper.ready
  }

  private stopLoginKeeper(): void {
    this.loginKeeper?.stop()
    this.loginKeeper = undefined
  }

  /** Deliver an operator message to the running process. Rejects when it cannot be taken. */
  async sendUserMessage(text: string): Promise<void> {
    if (!this.liveInput || this.terminalEventReceived) {
      throw new Error(
        `${this.vendor} session is not accepting live input (the run already ended or started without options.liveInput). Restart the run with the message instead.`,
      )
    }
    await this.writeUserMessage(text)
  }

  private async writeUserMessage(text: string): Promise<void> {
    const uuid = randomUUID()
    const message = {
      type: "user",
      uuid,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    }
    await this.queue.write(this.process?.stdin, uuid, message, this.vendor)
  }

  /** A live process only exits once stdin closes; a one-shot process already has it closed. */
  private closeLiveInput(): void {
    this.queue.activity()
    if (this.liveInput) this.process?.stdin?.end()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started && this.config !== null
    return super.isAlive()
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) return
    const stderrExhaustion = captureExhaustion(proc.stderr)
    const flush = readJsonLines(proc.stdout, (event) => this.handleEvent(event))
    const { exitCode: code } = await waitForStreamCompletion(proc)
    flush()
    this.queue.activity()
    // The process ended cleanly before taking the queued message; the finished turn still stands.
    if (code === 0 && this.queue.holding) this.completeRun("", {})
    this.nativeError ??= stderrExhaustion()
    this.finalizeNativeExit(code)
  }

  protected finalizeNativeExit(code: number | null): void {
    if (this.terminalEventReceived) return
    const exitCode = code ?? -1
    this.emitError(
      exitCode === -1 ? "TIMEOUT" : "CRASH",
      this.nativeError ??
        (exitCode === 0
          ? `${this.vendor} exited without a result event. Check CLI authentication and update the CLI, then retry.`
          : `${this.vendor} exited with code ${exitCode}. Run av doctor and check CLI authentication.`),
      exitCode !== 1,
    )
  }

  protected handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>
    // Any event after a held result means Claude is still working through the queue.
    this.queue.activity()

    switch (e.type) {
      case "user":
        // Claude echoes a stdin message at the moment it takes it off the queue.
        if (this.liveInput && e.isReplay === true) {
          this.queue.taken(typeof e.uuid === "string" ? e.uuid : undefined)
          this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        }
        break

      case "assistant": {
        const msg = e.message as Record<string, unknown> | undefined
        const content = msg?.content as Array<Record<string, unknown>> | undefined
        if (typeof e.error === "string") {
          const text = Array.isArray(content)
            ? content
                .filter((block) => block.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join("\n")
            : ""
          this.nativeError = [e.error, text].filter(Boolean).join(": ").slice(0, 10_240)
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && typeof block.text === "string") {
              // Stream-only — no accumulation, prevents OOM
              this.emit({ type: "output", chunk: block.text })
            }
            if (block.type === "tool_use") {
              const toolName = (block.name as string | undefined) ?? "unknown"
              const input = block.input as Record<string, unknown> | undefined
              this.emit({ type: "toolUse", tool: toolName, args: input ?? {} })

              const changeType = this.fileChangeType(toolName)
              if (changeType) {
                const path = input?.file_path as string | undefined
                if (path && !this.filesChanged.includes(path)) {
                  this.filesChanged.push(path)
                  this.emit({
                    type: "fileChange",
                    path,
                    changeType,
                  })
                }
              }
            }
          }
        }

        const usage = msg?.usage as Record<string, unknown> | undefined
        if (usage) {
          this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        }
        break
      }

      case "result": {
        const result = typeof e.result === "string" ? e.result : ""
        const isError = e.is_error === true

        if (isError) {
          const errors = Array.isArray(e.errors) ? e.errors.filter((error) => typeof error === "string") : []
          const message = [...new Set([result, ...errors, this.nativeError].filter(Boolean))].join("\n")
          this.emitError(
            "CRASH",
            message.slice(0, 10_240) ||
              String(e.subtype ?? "Claude execution failed. Check the agent output and retry."),
            true,
          )
          this.closeLiveInput()
        } else if (this.liveInput && (this.queue.pending || Number(e.queued_turn_count) > 0)) {
          // A message is queued behind this turn: Claude answers it in a follow-up
          // turn with its own result, so the run is not finished yet.
          this.heldUsage = sumUsage(this.heldUsage, this.extractTokenUsage(e))
          this.queue.hold(result)
        } else {
          this.completeRun(result, e)
        }
        break
      }

      case "system":
      case "rate_limit_event":
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        break
    }
  }

  /** Finish the run with this turn's result plus any turns held back before it. */
  private completeRun(result: string, resultEvent: Record<string, unknown>): void {
    const followedUp = this.queue.holding
    const output = [...this.queue.release(), result].filter(Boolean).join("\n\n")
    const tokenUsage = sumUsage(this.heldUsage, this.extractTokenUsage(resultEvent))
    this.heldUsage = undefined
    if (output.length > MAX_NATIVE_RESULT_LENGTH) {
      this.emitError("CRASH", nativeResultLimitMessage(this.vendor), false)
    } else {
      this.emit({
        type: "complete",
        result: {
          exitCode: 0,
          output,
          // duration_ms covers one turn; a run with follow-up turns is timed end to end.
          durationMs: followedUp
            ? this.elapsedMs()
            : ((resultEvent.duration_ms as number | undefined) ?? this.elapsedMs()),
          filesChanged: this.filesChanged,
          tokenUsage,
        },
      })
    }
    this.closeLiveInput()
  }

  protected extractTokenUsage(
    resultEvent: Record<string, unknown>,
  ): { input: number; output: number; model: string } | undefined {
    const usage = resultEvent.usage as Record<string, unknown> | undefined
    if (!usage) return undefined
    const inputTokens = (usage.input_tokens as number | undefined) ?? 0
    const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0
    const cacheCreation = (usage.cache_creation_input_tokens as number | undefined) ?? 0
    const output = (usage.output_tokens as number | undefined) ?? 0
    const model =
      (resultEvent.model as string | undefined) ?? (usage.model as string | undefined) ?? this.config?.model ?? "claude"
    return {
      input: inputTokens + cacheRead + cacheCreation,
      output,
      model,
    }
  }
}

/** Claude reports usage per turn, so a run with follow-up turns adds them up. */
function sumUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a || !b) return a ?? b
  return { input: a.input + b.input, output: a.output + b.output, model: b.model }
}
