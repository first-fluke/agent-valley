import { StringDecoder } from "node:string_decoder"

type Stream = "stdout" | "stderr"
type State = "text" | "escape" | "intermediate" | "csi" | "osc" | "oscEscape" | "string" | "stringEscape"

/** Incremental UTF-8/terminal decoding; escape bodies are discarded, never buffered. */
class TerminalStream {
  private readonly decoder = new StringDecoder("utf8")
  private state: State = "text"
  private ended = false

  constructor(private readonly append: (text: string) => void) {}

  write(chunk: Buffer): void {
    if (!this.ended) this.consume(this.decoder.write(chunk))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.consume(this.decoder.end())
    this.state = "text"
  }

  private consume(text: string): void {
    let printable = ""
    for (const char of text) {
      if (!this.accept(char)) continue
      printable += char
      if (printable.length >= 1_024) {
        this.append(printable)
        printable = ""
      }
    }
    if (printable) this.append(printable)
  }

  private accept(char: string): boolean {
    const code = char.codePointAt(0) as number
    switch (this.state) {
      case "osc":
      case "string":
        if (code === 0x9c || (this.state === "osc" && code === 0x07)) this.state = "text"
        else if (code === 0x1b) this.state = this.state === "osc" ? "oscEscape" : "stringEscape"
        return false
      case "oscEscape":
      case "stringEscape":
        if (char === "\\" || code === 0x9c || (this.state === "oscEscape" && code === 0x07)) this.state = "text"
        else if (code !== 0x1b) this.state = this.state === "oscEscape" ? "osc" : "string"
        return false
      case "csi":
        if (code === 0x1b) this.state = "escape"
        else if (code >= 0x40 && code <= 0x7e) this.state = "text"
        return false
      case "escape":
        if (char === "[") this.state = "csi"
        else if (char === "]") this.state = "osc"
        else if (["P", "X", "^", "_"].includes(char)) this.state = "string"
        else if (code >= 0x20 && code <= 0x2f) this.state = "intermediate"
        else if (code !== 0x1b) this.state = "text"
        return false
      case "intermediate":
        if (code === 0x1b) this.state = "escape"
        else if (code < 0x20 || code > 0x2f) this.state = "text"
        return false
      case "text":
        if (code === 0x1b) this.state = "escape"
        else if (code === 0x9b) this.state = "csi"
        else if (code === 0x9d) this.state = "osc"
        else if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) this.state = "string"
        else return code === 0x09 || code === 0x0a || (code >= 0x20 && (code < 0x7f || code > 0x9f))
        return false
    }
  }
}

/** Shared bounded tail with independent stdout/stderr decoder and ANSI state. */
export class BoundedProcessOutput {
  private value = ""
  private readonly streams = {
    stdout: new TerminalStream((text) => this.retain(text)),
    stderr: new TerminalStream((text) => this.retain(text)),
  }

  constructor(private readonly maxLength: number) {
    if (!Number.isSafeInteger(maxLength) || maxLength < 1)
      throw new RangeError("Output limit must be a positive integer.")
  }

  write(stream: Stream, chunk: Buffer): void {
    this.streams[stream].write(chunk)
  }

  /** Internal diagnostics must not be swallowed by an unfinished child escape. */
  append(text: string): void {
    const stream = new TerminalStream((part) => this.retain(part))
    stream.write(Buffer.from(text))
    stream.end()
  }

  end(stream: Stream): void {
    this.streams[stream].end()
  }

  finish(): string {
    this.end("stdout")
    this.end("stderr")
    return this.value
  }

  private retain(text: string): void {
    const tail = (this.value + text).slice(-this.maxLength)
    const first = tail.charCodeAt(0)
    this.value = first >= 0xdc00 && first <= 0xdfff ? tail.slice(1) : tail
  }
}
