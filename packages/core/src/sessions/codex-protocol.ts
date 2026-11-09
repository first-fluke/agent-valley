import type { ChildProcess } from "node:child_process"
import type { AgentConfig } from "./agent-session"
import { MAX_NATIVE_RESULT_LENGTH } from "./native-result"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** Retain provider codes when the human-readable message omits the exhaustion reason. */
export function extractCodexErrorMessage(value: unknown, fallback: string): string {
  if (typeof value === "string") return value.slice(0, 10_240)
  if (!value || typeof value !== "object") return fallback
  const error = value as Record<string, unknown>
  const data = error.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : undefined
  const details = [error.codexErrorInfo, error.code, error.type, data?.codexErrorInfo, data?.code, data?.type].filter(
    (part): part is string => typeof part === "string",
  )
  const message = typeof error.message === "string" ? error.message : fallback
  return [...new Set([...details, message])].join(": ").slice(0, 10_240)
}

export function codexExitError(proc: ChildProcess, exitCode: number | null, exhaustion?: string): Error {
  return new Error(
    exhaustion ??
      `Codex app-server exited (${proc.signalCode ?? exitCode ?? "unknown"}). Run av doctor and check Codex authentication.`,
  )
}

export function closeInputAndJoin(proc: ChildProcess): Promise<void> {
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

/**
 * Extract token usage from a `turn/completed` notification. The exact
 * wire schema for Codex app-server is not publicly pinned; this
 * parser tolerates several field naming conventions (`prompt_tokens` /
 * `completion_tokens` from the OpenAI REST shape, and the plain
 * `input` / `output` JSON-RPC convention). Returns `undefined` when no
 * usage block is present — BudgetService then skips accumulation for
 * this attempt (docs/plans/v0-2-bigbang-design.md § 6.4 E19).
 */
export function extractTokenUsage(
  params: Record<string, unknown> | undefined,
  defaultModel: string | undefined,
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
  const model = (usage.model as string | undefined) ?? (params.model as string | undefined) ?? defaultModel ?? "codex"
  return { input, output, model }
}

export function pauseCodexProcess(proc: ChildProcess | null, isAlive: boolean): void {
  if (!proc || !isAlive || proc.pid == null) {
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
    process.kill(proc.pid, "SIGSTOP")
  } catch (err) {
    throw new Error(
      `CodexSession.pause: failed to SIGSTOP pid=${proc.pid}: ${String(err)}.\n` +
        "  Fix: verify the process is still running and owned by this user.",
    )
  }
}

export function resumeCodexProcess(proc: ChildProcess | null): void {
  if (!proc || proc.pid == null) {
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
    process.kill(proc.pid, "SIGCONT")
  } catch (err) {
    throw new Error(
      `CodexSession.resume: failed to SIGCONT pid=${proc.pid}: ${String(err)}.\n` +
        "  Fix: verify the process is still present and previously paused.",
    )
  }
}

export function buildCodexAppServerArgs(config: AgentConfig): string[] {
  const args = ["app-server", "--listen", "stdio://"]
  if (config.model) {
    args.push("-c", `model=${JSON.stringify(config.model)}`)
  }
  return args
}

export interface CodexFileChange {
  path: string
  changeType: "add" | "modify" | "delete"
}

export function extractCodexFileChanges(item: Record<string, unknown>): CodexFileChange[] {
  const changes = item.changes as Array<{ path: string; kind: { type: string } }> | undefined
  if (!changes) return []
  return changes.map((change) => ({
    path: change.path,
    changeType: change.kind.type === "add" || change.kind.type === "delete" ? change.kind.type : "modify",
  }))
}

export function parseCodexAgentMessageItem(item: Record<string, unknown>): {
  phasedMessageSeen: boolean
  finalAnswer?: string
  finalAnswerExceeded?: boolean
  completedMessage?: string
  completedMessageExceeded?: boolean
} {
  const result: {
    phasedMessageSeen: boolean
    finalAnswer?: string
    finalAnswerExceeded?: boolean
    completedMessage?: string
    completedMessageExceeded?: boolean
  } = {
    phasedMessageSeen: item.phase != null,
  }
  if (typeof item.text === "string") {
    const exceeded = item.text.length > MAX_NATIVE_RESULT_LENGTH
    const text = exceeded ? undefined : item.text
    if (item.phase === "final_answer") {
      result.finalAnswer = text
      result.finalAnswerExceeded = exceeded
    } else if (item.phase == null) {
      result.completedMessage = text
      result.completedMessageExceeded = exceeded
    }
  }
  return result
}
