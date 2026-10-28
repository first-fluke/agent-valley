/**
 * CodexSession — Persistent JSON-RPC connection to `codex app-server`.
 *
 * Protocol: JSON-RPC 2.0 over stdio
 * Lifecycle: initialize → thread/start → turn/start → events → turn/completed
 */

import type { ChildProcess } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { BaseSession, waitForStreamCompletion } from "./base-session"
import { readJsonLines } from "./json-lines"

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
  private turnId: string | null = null
  private paused = false
  private disposing = false
  private tokenUsage: { input: number; output: number; model: string } | undefined
  private filesChanged: string[] = []
  private outputTail = ""
  private finalAnswer: string | undefined
  private completedMessage: string | undefined
  private phasedMessageSeen = false
  private cancellation: Promise<void> | undefined
  private shutdown: Promise<void> | undefined
  private shutdownFailure: Error | undefined
  private executionPrepared = false
  private interruptCompletion:
    | { threadId: string; turnId: string; resolve: () => void; reject: (error: Error) => void }
    | undefined
  private pendingResolvers = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  async start(config: AgentConfig): Promise<void> {
    this.config = config
    this.startedAt = Date.now()
    this.disposing = false
    this.shutdown = undefined
    this.shutdownFailure = undefined
    this.executionPrepared = false

    const args = ["app-server", "--listen", "stdio://"]
    if (config.model) {
      args.push("-c", `model=${JSON.stringify(config.model)}`)
    }

    // Containment for the per-turn `approvalPolicy: "never"` (set in
    // execute()) comes from the OS sandbox wrapping this process, not
    // from trusting the flag. planSandboxedSpawn() fails closed when no
    // sandbox is available unless SYMPHONY_ALLOW_UNSANDBOXED=1 is set —
    // let that rejection propagate so callers see a clear start() failure.
    const spawned = await this.spawnSandboxed({
      agentType: "codex",
      command: "codex",
      args,
      stdio: ["pipe", "pipe", "pipe"],
      rethrowSandboxError: true,
    })
    if (!spawned) return

    this.readStream()

    await this.rpc("initialize", {
      clientInfo: { name: "symphony-orchestrator", version: "1.0" },
    })
    this.process?.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`)
  }

  async execute(prompt: string): Promise<void> {
    if (!this.assertStarted()) return
    this.executionPrepared = true

    this.filesChanged = []
    this.outputTail = ""
    this.finalAnswer = undefined
    this.completedMessage = undefined
    this.phasedMessageSeen = false
    this.tokenUsage = undefined
    this.terminalEventReceived = false
    // Disable the previous thread before awaiting the new thread's RPC reply.
    this.threadId = null
    this.turnId = null

    const threadResult = (await this.rpc("thread/start", {
      cwd: this.config?.workspacePath,
      approvalPolicy: "never",
      sandbox: "workspace-write",
      ephemeral: true,
    })) as { thread: { id: string } }

    this.threadId = threadResult.thread.id

    const turnResult = (await this.rpc("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt }],
      // Codex's inner Seatbelt cannot apply inside AV's OS sandbox. Delegate
      // only when the trusted spawn plan confirms that containment is enforced.
      ...(this.sandboxPlatform === "darwin"
        ? { sandboxPolicy: { type: "externalSandbox", networkAccess: "restricted" } }
        : {}),
    })) as { turn?: { id: string } }
    if (!this.terminalEventReceived && turnResult.turn) this.turnId = turnResult.turn.id
  }

  override async cancel(): Promise<void> {
    if (this.cancellation) return this.cancellation
    const cancelling = this.cancelTurn()
    this.cancellation = cancelling
    try {
      await cancelling
    } finally {
      if (this.cancellation === cancelling) this.cancellation = undefined
    }
  }

  private async cancelTurn(): Promise<void> {
    if (this.paused) await this.resume()
    const threadId = this.threadId
    const turnId = this.turnId
    if (!threadId || !turnId) {
      await super.cancel()
      return
    }
    let rejectCompletion!: (error: Error) => void
    const completed = new Promise<void>((resolve, reject) => {
      rejectCompletion = reject
      this.interruptCompletion = { threadId, turnId, resolve, reject }
    })
    const timer = setTimeout(() => {
      rejectCompletion(
        new Error(
          "Codex did not confirm turn completion within 5 seconds of interruption. Inspect and reconcile the task before retrying.",
        ),
      )
    }, 5_000)
    timer.unref()
    let requestFailed = false
    try {
      // The interrupt reply only acknowledges the request. Disposing before the
      // matching terminal notification can strand the command in its own group.
      await Promise.all([
        completed,
        this.rpc("turn/interrupt", { threadId, turnId }).catch((error: unknown) => {
          requestFailed = true
          throw error
        }),
      ])
    } catch (error) {
      if (!requestFailed || this.disposing) throw error
      await super.cancel()
    } finally {
      clearTimeout(timer)
      if (this.interruptCompletion?.threadId === threadId && this.interruptCompletion.turnId === turnId)
        this.interruptCompletion = undefined
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
      this.paused = true
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
      this.paused = false
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
    if (!this.threadId || !this.turnId) {
      throw new Error(
        "CodexSession.sendUserMessage: no active turn.\n" +
          "  Fix: wait for execute() to start a turn before appending a prompt.",
      )
    }
    if (!this.assertStarted()) return
    if (this.paused) {
      throw new Error("Codex is paused. Resume the agent before appending a prompt.")
    }
    await this.rpc("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.turnId,
      input: [{ type: "text", text }],
    })
  }

  override async kill(): Promise<void> {
    if (this.shutdownFailure) throw this.shutdownFailure
    if (this.shutdown) return this.shutdown
    const proc = this.process
    if (!proc) return
    this.disposing = true
    this.rejectPending(new Error("Codex session disposed while waiting for an RPC response."))
    const shuttingDown = (async () => {
      if (!this.isAlive() && proc.pid && this.executionPrepared) {
        await this.forceUnconfirmedShutdown(
          new Error(
            "Codex exited before graceful shutdown was joined. Inspect its command processes and reconcile the task before retrying.",
          ),
        )
      }
      if (this.isAlive()) {
        try {
          await this.closeInputAndJoin(proc)
        } catch (error) {
          await this.forceUnconfirmedShutdown(
            new Error(
              "Codex graceful shutdown was not confirmed. Inspect its command processes and reconcile the task before retrying.",
              { cause: error },
            ),
          )
        }
      }
      await super.kill()
    })()
    this.shutdown = shuttingDown
    return shuttingDown
  }

  private async forceUnconfirmedShutdown(error: Error): Promise<never> {
    this.shutdownFailure = error
    try {
      await super.kill()
    } catch (forceError) {
      this.shutdownFailure = new AggregateError([error, forceError], error.message)
    }
    throw this.shutdownFailure
  }

  private closeInputAndJoin(proc: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      let inputError: Error | undefined
      const onInputError = (error: Error) => {
        inputError = error
      }
      const cleanup = () => {
        clearTimeout(timer)
        proc.off("close", onClose)
        proc.stdin?.off("error", onInputError)
      }
      const onClose = () => {
        cleanup()
        if (proc.exitCode === 0 && proc.signalCode == null) resolve()
        else
          reject(
            new Error(`Codex shutdown exited with ${proc.signalCode ?? proc.exitCode ?? "unknown"}.`, {
              cause: inputError,
            }),
          )
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error("Codex did not exit within 5 seconds of closing its input.", { cause: inputError }))
      }, 5_000)
      timer.unref()
      proc.once("close", onClose)
      proc.stdin?.on("error", onInputError)
      try {
        if (!proc.stdin) throw new Error("Codex stdin pipe is unavailable.")
        proc.stdin.end()
      } catch (error) {
        cleanup()
        reject(error)
      }
    })
  }

  override async dispose(): Promise<void> {
    await this.kill()
    await super.dispose()
    this.threadId = null
    this.turnId = null
    this.paused = false
  }

  // ── JSON-RPC transport ──────────────────────────────────────────────────

  private rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const stdin = this.process?.stdin
    if (!stdin || stdin.destroyed || !this.isAlive()) {
      return Promise.reject(
        new Error(`Codex is not running; cannot send ${method}. Run av doctor and restart the task.`),
      )
    }
    const id = ++this.rpcId
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingResolvers.delete(id)
        reject(new Error(`RPC timeout for ${method} (id=${id}). Check Codex authentication and process logs.`))
      }, 30_000)
      timer.unref()
      this.pendingResolvers.set(id, { resolve, reject, timer })
      stdin.write(`${JSON.stringify(request)}\n`, (error) => {
        if (!error) return
        const pending = this.pendingResolvers.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pendingResolvers.delete(id)
        pending.reject(error)
      })
    })
  }

  private readStream(): void {
    const proc = this.process
    if (!proc?.stdout) return
    const flush = readJsonLines(proc.stdout, (message) => {
      if (typeof message === "object" && message !== null) this.handleMessage(message as JsonRpcResponse)
    })
    proc.once("error", (error) => this.rejectPending(error))
    void waitForStreamCompletion(proc).then(({ exitCode }) => {
      flush()
      const error = new Error(
        `Codex app-server exited (${proc.signalCode ?? exitCode ?? "unknown"}). Run av doctor and check Codex authentication.`,
      )
      this.rejectPending(error)
      if (!this.disposing && !this.terminalEventReceived) this.emitError("CRASH", error.message, true)
    })
  }

  private rejectPending(error: Error): void {
    this.interruptCompletion?.reject(error)
    for (const pending of this.pendingResolvers.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingResolvers.clear()
  }

  private handleMessage(msg: JsonRpcResponse): void {
    if (this.disposing) return
    // Response to a request we made
    if (msg.id != null && this.pendingResolvers.has(msg.id)) {
      const resolver = this.pendingResolvers.get(msg.id)
      if (!resolver) return
      this.pendingResolvers.delete(msg.id)
      clearTimeout(resolver.timer)
      if (msg.error) {
        resolver.reject(new Error(msg.error.message))
      } else {
        resolver.resolve(msg.result)
      }
      return
    }

    // Until thread/start replies, late notifications cannot supply a new result.
    if (!this.threadId && msg.method !== "error") return
    // Notifications for other threads must not complete or steer this run.
    if (msg.params?.threadId && msg.params.threadId !== this.threadId) return
    if (msg.params?.turnId && this.turnId && msg.params.turnId !== this.turnId) return
    if (this.terminalEventReceived) return
    switch (msg.method) {
      case "turn/started": {
        const turn = msg.params?.turn as { id?: string } | undefined
        this.turnId = turn?.id ?? this.turnId
        break
      }
      case "thread/tokenUsage/updated": {
        const usage = msg.params?.tokenUsage as { total?: { inputTokens: number; outputTokens: number } } | undefined
        if (usage?.total) {
          this.tokenUsage = {
            input: usage.total.inputTokens,
            output: usage.total.outputTokens,
            model: this.config?.model ?? "codex",
          }
        }
        break
      }
      case "item/agentMessage/delta": {
        const chunk = (msg.params?.delta as string | undefined) ?? ""
        this.outputTail = (this.outputTail + chunk).slice(-10240)
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

      case "item/completed": {
        const item = msg.params?.item as
          | {
              type?: string
              text?: string
              phase?: string | null
              changes?: Array<{ path: string; kind: { type: string } }>
            }
          | undefined
        if (item?.type === "agentMessage") {
          if (item.phase != null) this.phasedMessageSeen = true
          if (typeof item.text === "string") {
            const text = item.text.slice(-10240)
            if (item.phase === "final_answer") this.finalAnswer = text
            else if (item.phase == null) this.completedMessage = text
          }
        }
        if (item?.type === "fileChange") {
          for (const change of item.changes ?? []) {
            if (!this.filesChanged.includes(change.path)) this.filesChanged.push(change.path)
            const kind = change.kind.type
            this.emit({
              type: "fileChange",
              path: change.path,
              changeType: kind === "add" || kind === "delete" ? kind : "modify",
            })
          }
        }
        break
      }

      case "turn/completed": {
        const turn = msg.params?.turn as { id?: string; status?: string; error?: { message?: string } } | undefined
        if (turn?.id && this.turnId && turn.id !== this.turnId) return
        const interrupt = this.interruptCompletion
        if (interrupt?.threadId === this.threadId && interrupt.turnId === turn?.id) {
          if (turn?.status && ["completed", "interrupted", "failed"].includes(turn.status)) interrupt.resolve()
          else
            interrupt.reject(
              new Error("Codex interruption has no valid turn completion status. Inspect the task before retrying."),
            )
        }
        this.turnId = null
        if (turn?.status !== "completed") {
          this.emitError(
            "CRASH",
            turn?.error?.message ??
              `Codex turn ${turn?.status ?? "has no completion status"}. Check the agent output and retry.`,
            true,
          )
          break
        }
        // Progress deltas stay live, but structured consumers need the answer
        // declared by the protocol. Older delta-only servers retain their tail.
        const output = this.finalAnswer ?? this.completedMessage ?? (this.phasedMessageSeen ? "" : this.outputTail)
        const result = this.buildRunResult(output, this.filesChanged)
        result.exitCode = 0
        const usage = this.tokenUsage ?? this.extractTokenUsage(msg.params)
        if (usage) result.tokenUsage = usage
        this.emit({ type: "complete", result })
        break
      }

      case "error": {
        // The server retries transient provider errors within the same turn.
        if (msg.params?.willRetry === true) {
          this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
          break
        }
        const error = msg.params?.error as { message?: string } | undefined
        const errMsg = error?.message ?? (msg.params?.message as string | undefined) ?? "Unknown codex error"
        this.emitError("UNKNOWN", errMsg, true)
        break
      }

      default:
        this.emit({ type: "heartbeat", timestamp: new Date().toISOString() })
    }
  }

  /**
   * Extract token usage from a `turn/completed` notification. The exact
   * wire schema for Codex app-server is not publicly pinned; this
   * parser tolerates several field naming conventions (`prompt_tokens` /
   * `completion_tokens` from the OpenAI REST shape, and the plain
   * `input` / `output` JSON-RPC convention). Returns `undefined` when no
   * usage block is present — BudgetService then skips accumulation for
   * this attempt (docs/plans/v0-2-bigbang-design.md § 6.4 E19).
   */
  private extractTokenUsage(
    params: Record<string, unknown> | undefined,
  ): { input: number; output: number; model: string } | undefined {
    if (!params) return undefined
    const usage = params.usage as Record<string, unknown> | undefined
    if (!usage) return undefined
    const input =
      (usage.input as number | undefined) ??
      (usage.input_tokens as number | undefined) ??
      (usage.prompt_tokens as number | undefined) ??
      0
    const output =
      (usage.output as number | undefined) ??
      (usage.output_tokens as number | undefined) ??
      (usage.completion_tokens as number | undefined) ??
      0
    if (input === 0 && output === 0) return undefined
    const model =
      (usage.model as string | undefined) ?? (params.model as string | undefined) ?? this.config?.model ?? "codex"
    return { input, output, model }
  }
}
