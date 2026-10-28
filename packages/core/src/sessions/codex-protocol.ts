import type { ChildProcess } from "node:child_process"

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
  error?: { code: number; message: string }
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
