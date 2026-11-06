import type { Readable } from "node:stream"
import { classifyAgentExhaustion } from "../domain/agent-exhaustion"

/** Reads only error-envelope fields; arbitrary event payloads are not error evidence. */
export function nativeErrorMessage(value: unknown, fallback: string): string {
  const parts: string[] = []
  const collect = (entry: unknown, depth: number): void => {
    if (typeof entry === "string") {
      if (entry) parts.push(entry.slice(0, 4_096))
      return
    }
    if (!entry || typeof entry !== "object" || depth > 3) return
    if (Array.isArray(entry)) {
      for (const item of entry.slice(0, 8)) collect(item, depth + 1)
      return
    }
    const envelope = entry as Record<string, unknown>
    if (depth > 0) collect(envelope.type, depth + 1)
    for (const key of ["code", "message", "result", "text", "errors", "error", "data"]) {
      collect(envelope[key], depth + 1)
    }
  }
  collect(value, 0)
  return [...new Set(parts)].join("\n").slice(0, 10_240) || fallback
}

/** Propagate exhaustion without copying arbitrary CLI stderr, which can contain credentials. */
export function exhaustionMessage(text: string): string | undefined {
  const kind = classifyAgentExhaustion(text)
  return kind === "context"
    ? "context_length_exceeded: The native CLI reported exhausted context. Continue from the saved checkpoint in a fresh session."
    : kind === "usage"
      ? "usage_limit_reached: The native CLI reported exhausted provider allowance. Use another authenticated provider or restore the allowance."
      : undefined
}

/** Retains a bounded private tail for native CLIs that fail without a structured error event. */
export function captureExhaustion(stream: Readable | null | undefined): () => string | undefined {
  let tail = ""
  let failure: string | undefined
  const decoder = new TextDecoder()
  stream?.on("data", (chunk: Buffer) => {
    tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4_096)
    failure ??= exhaustionMessage(tail)
  })
  return () => failure
}
