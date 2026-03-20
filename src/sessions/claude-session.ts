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

import { BaseSession, buildAgentEnv } from "./base-session"
import type { AgentConfig } from "./agent-session"

export class ClaudeSession extends BaseSession {
  private output = ""
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

    this.output = ""
    this.filesChanged = []
    this.startedAt = Date.now()

    const args = [
      "--print",
      "--output-format", "stream-json",
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
    this.process = Bun.spawn(["claude", ...args], {
      cwd: this.config.workspacePath,
      env: buildAgentEnv("claude", this.config.env),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    const sink = this.process.stdin as import("bun").FileSink
    sink.write(prompt)
    sink.end()

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

    const stdout = proc.stdout as ReadableStream<Uint8Array>
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
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
      }
    } catch {
      // Stream ended
    }

    await proc.exited
    const exitCode = proc.exitCode ?? -1

    // If we haven't emitted a complete event from the "result" message, emit now
    if (exitCode !== 0) {
      this.emitError(
        exitCode === -1 ? "TIMEOUT" : "CRASH",
        `claude exited with code ${exitCode}`,
        exitCode !== 1,
      )
    }
  }

  private handleEvent(event: unknown): void {
    if (typeof event !== "object" || event === null) return
    const e = event as Record<string, unknown>

    switch (e["type"]) {
      case "assistant": {
        const msg = e["message"] as Record<string, unknown> | undefined
        const content = msg?.["content"] as Array<Record<string, unknown>> | undefined
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block["type"] === "text" && typeof block["text"] === "string") {
              this.output += block["text"]
              this.emit({ type: "output", chunk: block["text"] })
            }
            if (block["type"] === "tool_use") {
              const toolName = (block["name"] as string | undefined) ?? "unknown"
              const input = block["input"] as Record<string, unknown> | undefined
              this.emit({ type: "toolUse", tool: toolName, args: input ?? {} })

              if (toolName === "Edit" || toolName === "Write") {
                const path = input?.["file_path"] as string | undefined
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

        // Token usage from message
        const usage = msg?.["usage"] as Record<string, unknown> | undefined
        if (usage) {
          this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
        }
        break
      }

      case "result": {
        const result = (e["result"] as string | undefined) ?? this.output
        const durationMs = (e["duration_ms"] as number | undefined) ?? this.elapsedMs()
        const isError = e["is_error"] === true

        if (isError) {
          this.emitError("CRASH", result, true)
        } else {
          this.emit({
            type: "complete",
            result: {
              exitCode: 0,
              output: result.length > 10240 ? result.slice(0, 10240) : result,
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

  private extractTokenUsage(resultEvent: Record<string, unknown>): { input: number; output: number } | undefined {
    const usage = resultEvent["usage"] as Record<string, unknown> | undefined
    if (!usage) return undefined
    const input = (usage["input_tokens"] as number | undefined) ?? 0
    const output = (usage["output_tokens"] as number | undefined) ?? 0
    return { input, output }
  }
}
