import type { Readable } from "node:stream"

/** Consume NDJSON, including a final record without a newline. Returns a final flush. */
export function readJsonLines(
  stream: Readable,
  onEvent: (event: unknown) => void,
  onText?: (text: string) => void,
): () => void {
  const decoder = new TextDecoder()
  let buffer = ""
  const parse = (line: string) => {
    if (!line.trim()) return
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return // Some CLIs mix diagnostic text with their structured output.
    }
    onEvent(event)
  }
  stream.on("data", (chunk: Buffer) => {
    const text = decoder.decode(chunk, { stream: true })
    onText?.(text)
    buffer += text
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) parse(line)
  })
  stream.on("error", () => {})
  return () => {
    parse(buffer + decoder.decode())
    buffer = ""
  }
}
