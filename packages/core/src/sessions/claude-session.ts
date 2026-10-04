/**
 * ClaudeSession — Claude Code with streaming NDJSON output.
 *
 * Mode: claude --print --output-format stream-json
 * Input: prompt passed via stdin as plain text
 * Output: NDJSON lines — system init, assistant messages, tool use, result
 *
 * Note: Claude Code is NOT a persistent server. Each execute() spawns a new process.
 * The "session" manages process lifecycle and event normalization.
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv, waitForStreamCompletion } from "./base-session"
import { readJsonLines } from "./json-lines"
import { planSandboxedSpawn } from "./sandbox"

export class ClaudeSession extends BaseSession {
  protected filesChanged: string[] = []
  protected readonly vendor: string = "claude"
  private started = false

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

    if (this.config?.model) {
      args.push("--model", this.config?.model)
    }

    const effort = this.config?.options?.effort as string | undefined
    if (effort) {
      args.push("--effort", effort)
    }

    return args
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
    this.resetNativeState()
    this.startedAt = Date.now()

    const args = this.buildArgs()
    // Containment for --dangerously-skip-permissions comes from the OS
    // sandbox wrapping this spawn, not from trusting the flag itself.
    // planSandboxedSpawn() fails closed (throws) when no sandbox is
    // available unless SYMPHONY_ALLOW_UNSANDBOXED=1 is set.
    let plan: Awaited<ReturnType<typeof planSandboxedSpawn>>
    try {
      plan = await planSandboxedSpawn({
        agentType: this.vendor,
        command: this.vendor,
        args,
        workspacePath: this.config.workspacePath,
      })
    } catch (err) {
      this.emitError("CRASH", `${err}`, false)
      return
    }

    // Pass prompt via stdin to avoid arg length/injection issues
    this.process = spawn(plan.command, plan.args, {
      detached: process.platform !== "win32",
      cwd: this.config.workspacePath,
      env: buildAgentEnv(this.vendor, this.config.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.process.stdin?.write(prompt, "utf-8")
    this.process.stdin?.end()

    await this.readStream()
  }

  override isAlive(): boolean {
    if (!this.process) return this.started
    return super.isAlive()
  }

  // ── Stream parser ───────────────────────────────────────────────────────

  private async readStream(): Promise<void> {
    const proc = this.process
    if (!proc?.stdout) return
    const flush = readJsonLines(proc.stdout, (event) => this.handleEvent(event))
    const { exitCode: code } = await waitForStreamCompletion(proc)
    flush()
    this.finalizeNativeExit(code)
  }

  protected finalizeNativeExit(code: number | null): void {
    if (this.terminalEventReceived) return
    const exitCode = code ?? -1
    this.emitError(
      exitCode === -1 ? "TIMEOUT" : "CRASH",
      exitCode === 0
        ? `${this.vendor} exited without a result event. Check CLI authentication and update the CLI, then retry.`
        : `${this.vendor} exited with code ${exitCode}. Run av doctor and check CLI authentication.`,
      exitCode !== 1,
    )
  }

  protected handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>

    switch (e.type) {
      case "assistant": {
        const msg = e.message as Record<string, unknown> | undefined
        const content = msg?.content as Array<Record<string, unknown>> | undefined
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
        const result = (e.result as string | undefined) ?? ""
        const durationMs = (e.duration_ms as number | undefined) ?? this.elapsedMs()
        const isError = e.is_error === true

        if (isError) {
          this.emitError("CRASH", result, true)
        } else {
          this.emit({
            type: "complete",
            result: {
              exitCode: 0,
              output: result.length > 10240 ? result.slice(-10240) : result,
              durationMs,
              filesChanged: this.filesChanged,
              tokenUsage: this.extractTokenUsage(e),
            },
          })
        }
        break
      }

      case "system":
      case "rate_limit_event":
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        break
    }
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
