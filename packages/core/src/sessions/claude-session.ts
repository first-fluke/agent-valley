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
import { BaseSession, buildAgentEnv } from "./base-session"

export class ClaudeSession extends BaseSession {
  private filesChanged: string[] = []
  private started = false

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
    this.startedAt = Date.now()

    const args = [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--no-session-persistence",
    ]

    if (this.config.model) {
      args.push("--model", this.config.model)
    }

    const effort = this.config.options?.effort as string | undefined
    if (effort) {
      args.push("--effort", effort)
    }

    // Pass prompt via stdin to avoid arg length/injection issues
    this.process = spawn("claude", args, {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("claude", this.config.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.process.stdin?.write(prompt, "utf-8")
    this.process.stdin?.end()

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
            // Non-JSON stderr noise
          }
        }
      })

      proc.stdout.on("error", () => {
        // Stream error — proceed to close
      })

      proc.once("close", (code) => {
        const exitCode = code ?? -1

        if (exitCode !== 0) {
          this.emitError(exitCode === -1 ? "TIMEOUT" : "CRASH", `claude exited with code ${exitCode}`, exitCode !== 1)
        }

        resolve()
      })
    })
  }

  private handleEvent(event: unknown): void {
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

              if (toolName === "Edit" || toolName === "Write") {
                const path = input?.file_path as string | undefined
                if (path && !this.filesChanged.includes(path)) {
                  this.filesChanged.push(path)
                  this.emit({
                    type: "fileChange",
                    path,
                    changeType: toolName === "Write" ? "add" : "modify",
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

  private extractTokenUsage(
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
