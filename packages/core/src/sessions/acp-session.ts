/**
 * AcpCapableSession — a one-shot CLI session that can instead hold an ACP
 * session open when the run asks for live input (`options.liveInput`).
 *
 * The vendor session keeps its one-shot `execute()`; it calls
 * `executeOverAcp()` first and falls through to the one-shot path when that
 * returns false (live input not requested, or the CLI does not speak ACP).
 */

import { logger } from "../observability/logger"
import { AcpRun, isAcpAgentError } from "./acp-run"
import { BaseSession } from "./base-session"
import { exhaustionMessage } from "./native-failure"
import { nativeResultLimitMessage } from "./native-result"

export interface AcpAgentSpec {
  /** Agent type for sandbox planning and the credential allowlist. */
  agentType: string
  command: string
  /** Arguments that start the CLI's ACP server on stdio, e.g. `["acp"]`. */
  args: string[]
  /** Agent name for messages, e.g. "OpenCode". */
  label: string
  /** A pattern for the agent's "not signed in" errors, and what the operator is told instead. */
  auth?: [pattern: RegExp, message: string]
}

const MAX_ERROR_LENGTH = 10_240

export abstract class AcpCapableSession extends BaseSession {
  private acpRun: AcpRun | null = null
  private stopRequested = false

  /**
   * Run the prompt in an ACP session. Returns true when the run was handled
   * here (a terminal event was emitted), false when the caller should run its
   * one-shot path instead.
   */
  protected async executeOverAcp(prompt: string, spec: AcpAgentSpec): Promise<boolean> {
    const config = this.config
    if (config?.options?.liveInput !== true) return false
    this.stopRequested = false
    this.startedAt = Date.now()

    const spawned = await this.spawnSandboxed({
      agentType: spec.agentType,
      command: spec.command,
      args: spec.args,
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (!spawned) return true
    const proc = this.process
    if (!proc) return true

    const run = new AcpRun(proc, {
      cwd: config.workspacePath,
      model: config.model,
      label: spec.label,
      events: {
        output: (chunk) => this.emit({ type: "output", chunk }),
        toolUse: (tool, args) => this.emit({ type: "toolUse", tool, args }),
        fileChange: (path, changeType) => this.emit({ type: "fileChange", path, changeType }),
        activity: () => this.emit({ type: "heartbeat", timestamp: new Date().toISOString() }),
      },
    })

    try {
      await run.open()
    } catch (error) {
      run.close()
      if (this.stopRequested) {
        this.emitError("CANCELLED", `${spec.label} was stopped before the run started.`, false)
        return true
      }
      // A spawn failure was already reported through the process error handler.
      if (this.terminalEventReceived) return true
      if (isAcpAgentError(error)) {
        // The process speaks ACP but refused the session (auth, model, config): that is the run's failure.
        this.failAcpRun(error, spec)
        await super.kill()
        return true
      }
      // No ACP answer at all: an older CLI without this mode. The one-shot path still works there.
      logger.warn("sessions.acp", `${spec.label} did not start an ACP session; running one-shot instead`, {
        error: String(error).slice(0, 500),
      })
      await super.kill()
      return false
    }

    this.acpRun = run
    try {
      const result = await run.run(prompt)
      if (result.outputExceeded) {
        this.emitError("CRASH", nativeResultLimitMessage(spec.label), false)
      } else {
        this.emit({
          type: "complete",
          result: {
            exitCode: 0,
            output: result.output,
            durationMs: this.elapsedMs(),
            filesChanged: run.filesChanged,
            tokenUsage: result.tokenUsage,
          },
        })
      }
    } catch (error) {
      if (this.stopRequested) this.emitError("CANCELLED", `${spec.label} run was stopped.`, false)
      else this.failAcpRun(error, spec)
    } finally {
      this.acpRun = null
      run.close()
      // An ACP server only exits once its input closes.
      proc.stdin?.end()
    }
    return true
  }

  /** Deliver an operator message to the open ACP session. Rejects when there is none. */
  async sendUserMessage(text: string): Promise<void> {
    if (!this.acpRun) {
      throw new Error(
        "This session is not accepting live input (the run already ended or is running one-shot). Restart the run with the message instead.",
      )
    }
    await this.acpRun.send(text)
  }

  override async cancel(): Promise<void> {
    this.stopRequested = true
    await super.cancel()
  }

  override async kill(): Promise<void> {
    this.stopRequested = true
    await super.kill()
  }

  private failAcpRun(error: unknown, spec: AcpAgentSpec): void {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH)
    if (spec.auth?.[0].test(message)) {
      this.emitError("AUTH_FAILED", spec.auth[1], false)
      return
    }
    this.emitError("CRASH", exhaustionMessage(message) ?? `${spec.label} run failed over ACP: ${message}`, true)
  }
}
