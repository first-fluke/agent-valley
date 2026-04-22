/**
 * CodexSession — Persistent JSON-RPC connection to `codex app-server`.
 *
 * Protocol: JSON-RPC 2.0 over stdio
 * Lifecycle: initialize → thread/start → turn/start → events → turn/completed
 */

import { spawn } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, buildAgentEnv } from "./base-session"

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string }
}

export class CodexSession extends BaseSession {
  private rpcId = 0
  private threadId: string | null = null
  private filesChanged: string[] = []
  private outputChunks: string[] = []
  private pendingResolvers = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
    }
  >()

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.startedAt = Date.now()

    const args = ["app-server", "--listen", "stdio://"]
    if (config.model) {
      args.push("-c", `model="${config.model}"`)
    }

    this.process = spawn("codex", args, {
      cwd: config.workspacePath,
      env: buildAgentEnv("codex", config.env) as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    })

    this.readStream()

    await this.rpc("initialize", {
      clientInfo: { name: "symphony-orchestrator", version: "1.0" },
    })
  }

  async execute(prompt: string): Promise<void> {
    if (!this.assertStarted()) return

    this.filesChanged = []
    this.outputChunks = []

    const threadResult = (await this.rpc("thread/start", {
      cwd: this.config?.workspacePath,
      approvalPolicy: "never",
      ephemeral: true,
    })) as { thread: { id: string } }

    this.threadId = threadResult.thread.id

    await this.rpc("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
    })
  }

  override async cancel(): Promise<void> {
    if (this.threadId) {
      try {
        await this.rpc("turn/interrupt", { threadId: this.threadId })
      } catch {
        await super.cancel()
      }
    } else {
      await super.cancel()
    }
  }

  // ── Live intervention (C) ──────────────────────────────────────────────

  /**
   * Pause the Codex process via SIGSTOP. Unix-only — Windows has no
   * equivalent signal, so we throw with an actionable hint.
   */
  async pause(): Promise<void> {
    if (!this.process || !this.isAlive() || this.process.pid == null) {
      throw new Error(
        "CodexSession.pause: no live process to pause.\n" +
          "  Fix: check session.isAlive() before dispatching a pause intervention.\n" +
          "  Source: InterventionBus should gate on RunHandle.isAlive().",
      )
    }
    if (process.platform === "win32") {
      throw new Error(
        "CodexSession.pause: SIGSTOP is not supported on Windows.\n" +
          "  Fix: pause/resume interventions require a POSIX platform. Use `abort` instead.\n" +
          "  Tracking: docs/plans/v0-2-bigbang-design.md § 6.3 (E12).",
      )
    }
    try {
      process.kill(this.process.pid, "SIGSTOP")
    } catch (err) {
      throw new Error(
        `CodexSession.pause: failed to SIGSTOP pid=${this.process.pid}: ${String(err)}.\n` +
          "  Fix: verify the process is still running and owned by this user.",
      )
    }
  }

  /** Resume a paused Codex process via SIGCONT. Unix-only. */
  async resume(): Promise<void> {
    if (!this.process || this.process.pid == null) {
      throw new Error(
        "CodexSession.resume: no process to resume.\n" +
          "  Fix: ensure the session was previously paused before calling resume.",
      )
    }
    if (process.platform === "win32") {
      throw new Error(
        "CodexSession.resume: SIGCONT is not supported on Windows.\n" +
          "  Fix: pause/resume interventions require a POSIX platform.",
      )
    }
    try {
      process.kill(this.process.pid, "SIGCONT")
    } catch (err) {
      throw new Error(
        `CodexSession.resume: failed to SIGCONT pid=${this.process.pid}: ${String(err)}.\n` +
          "  Fix: verify the process is still present and previously paused.",
      )
    }
  }

  /**
   * Deliver a mid-run user message via JSON-RPC. Works without
   * restarting the turn — the server treats it as another input chunk
   * on the active thread.
   */
  async sendUserMessage(text: string): Promise<void> {
    if (!this.threadId) {
      throw new Error(
        "CodexSession.sendUserMessage: no active thread.\n" +
          "  Fix: wait for execute() to initialize the thread before appending a prompt.",
      )
    }
    if (!this.assertStarted()) return
    await this.rpc("turn/append", {
      threadId: this.threadId,
      input: [{ type: "text", text }],
    })
  }

  override async dispose(): Promise<void> {
    for (const [id, { reject }] of Array.from(this.pendingResolvers.entries())) {
      reject(new Error(`Session disposed while waiting for RPC id=${id}`))
    }
    this.pendingResolvers.clear()
    await super.dispose()
  }

  // ── JSON-RPC transport ──────────────────────────────────────────────────

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.rpcId
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    const line = `${JSON.stringify(request)}\n`
    this.process?.stdin?.write(line)

    return new Promise((resolve, reject) => {
      this.pendingResolvers.set(id, { resolve, reject })
      setTimeout(() => {
        if (this.pendingResolvers.has(id)) {
          this.pendingResolvers.delete(id)
          reject(new Error(`RPC timeout for ${method} (id=${id})`))
        }
      }, 30_000)
    })
  }

  private readStream(): void {
    if (!this.process?.stdout) return

    const decoder = new TextDecoder()
    let buffer = ""

    this.process.stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg: JsonRpcResponse = JSON.parse(line)
          this.handleMessage(msg)
        } catch {
          this.emit({ type: "output", chunk: line })
        }
      }
    })

    this.process.stdout.on("error", () => {
      // Stream error — ignore, process close will handle cleanup
    })
  }

  private handleMessage(msg: JsonRpcResponse): void {
    // Response to a request we made
    if (msg.id != null && this.pendingResolvers.has(msg.id)) {
      const resolver = this.pendingResolvers.get(msg.id)
      if (!resolver) return
      this.pendingResolvers.delete(msg.id)
      if (msg.error) {
        resolver.reject(new Error(msg.error.message))
      } else {
        resolver.resolve(msg.result)
      }
      return
    }

    // Server notification
    switch (msg.method) {
      case "item/agentMessage/delta": {
        const chunk = (msg.params?.delta as string | undefined) ?? ""
        this.outputChunks.push(chunk)
        this.emit({ type: "output", chunk })
        break
      }

      case "item/commandExecution/outputDelta": {
        const tool = (msg.params?.command as string | undefined) ?? "shell"
        this.emit({ type: "toolUse", tool, args: msg.params })
        break
      }

      case "item/fileChange/outputDelta": {
        const path = (msg.params?.path as string | undefined) ?? ""
        const rawType = msg.params?.changeType as string | undefined
        const changeType: "add" | "modify" | "delete" = rawType === "add" || rawType === "delete" ? rawType : "modify"
        if (path && !this.filesChanged.includes(path)) {
          this.filesChanged.push(path)
        }
        this.emit({ type: "fileChange", path, changeType })
        break
      }

      case "turn/completed": {
        const result = this.buildRunResult(this.outputChunks.join(""), this.filesChanged)
        result.exitCode = 0
        this.emit({ type: "complete", result })
        break
      }

      case "error": {
        const errMsg = (msg.params?.message as string | undefined) ?? "Unknown codex error"
        this.emitError("UNKNOWN", errMsg, true)
        break
      }

      default:
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
    }
  }
}
