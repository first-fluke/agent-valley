/**
 * Terminal rendering and input parsing for `av attach`. Pure: no I/O beyond
 * the `write` callback, so it is exercised directly in tests.
 */

import type { ThreadBacklog, ThreadEntry, ThreadUpdate } from "@agent-valley/core/domain/issue-thread"
import type { InterventionCommand } from "@agent-valley/core/domain/ports/agent-runner"

// ── Input ─────────────────────────────────────────────────────────────

export type AttachInput =
  | { type: "empty" }
  | { type: "message"; text: string }
  | { type: "command"; command: InterventionCommand }
  | { type: "quit" }
  | { type: "help" }
  | { type: "unknown"; name: string }

export const ATTACH_HELP = [
  "<text>            send a message to the actor",
  "/pause  /resume   pause or resume the run (agents that support it)",
  "/abort [reason]   stop the run and cancel the issue",
  "/quit             detach; the actor keeps running",
  "//text            send a message that starts with a slash",
].join("\n")

/** Interpret one line typed at the attach prompt. */
export function parseAttachInput(line: string): AttachInput {
  const trimmed = line.trim()
  if (!trimmed) return { type: "empty" }
  if (trimmed.startsWith("//")) return { type: "message", text: trimmed.slice(1) }
  if (!trimmed.startsWith("/")) return { type: "message", text: trimmed }

  const [name = "", ...rest] = trimmed.slice(1).split(/\s+/)
  switch (name.toLowerCase()) {
    case "pause":
      return { type: "command", command: { kind: "pause" } }
    case "resume":
      return { type: "command", command: { kind: "resume" } }
    case "abort":
      return { type: "command", command: { kind: "abort", reason: rest.join(" ") || "operator_requested" } }
    case "quit":
    case "exit":
    case "q":
      return { type: "quit" }
    case "help":
    case "?":
      return { type: "help" }
    default:
      return { type: "unknown", name }
  }
}

// ── Output ────────────────────────────────────────────────────────────

/**
 * Actor output is untrusted text headed for the operator's terminal: drop
 * escape sequences and control characters so it cannot move the cursor,
 * recolor the screen, or rewrite earlier lines. Newlines and tabs stay.
 */
export function sanitizeForTerminal(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g, "")
      .replace(/\r\n?/g, "\n")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
  )
}

export interface ThreadStyle {
  dim(text: string): string
  accent(text: string): string
}

const PLAIN_STYLE: ThreadStyle = { dim: (text) => text, accent: (text) => text }

/** Streamed output with no newline is held this long before it is shown as a partial line. */
export const PARTIAL_LINE_FLUSH_MS = 400

/**
 * Turns thread entries into whole terminal lines. Streamed output arrives in
 * fragments; lines are written once complete so they never interleave with
 * the prompt, and a fragment left hanging is flushed after a short pause.
 */
export class ThreadPrinter {
  private lastSeq = 0
  /** Characters of entry `lastSeq` already taken (printed or pending). */
  private consumed = 0
  private pending = ""
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly write: (line: string) => void,
    private readonly style: ThreadStyle = PLAIN_STYLE,
  ) {}

  /** Show a (re)sent backlog: at most `tail` earlier entries first time, then only what is new. */
  backlog(backlog: ThreadBacklog, tail = 30): void {
    let entries = backlog.entries
    const newest = entries[entries.length - 1]
    if (newest && newest.seq < this.lastSeq) {
      // Sequence numbers went backwards: the orchestrator restarted with a fresh thread.
      this.flush()
      this.lastSeq = 0
      this.consumed = 0
    }
    if (this.lastSeq === 0 && entries.length > tail) {
      const hidden = entries.length - tail
      entries = entries.slice(hidden)
      this.write(this.style.dim(`… ${hidden} earlier ${hidden === 1 ? "entry" : "entries"} not shown`))
    }
    for (const entry of entries) {
      if (entry.seq < this.lastSeq) continue
      if (entry.seq === this.lastSeq) {
        if (entry.kind === "output" && entry.text.length > this.consumed) {
          this.output(entry.text.slice(this.consumed))
          this.consumed = entry.text.length
        }
        continue
      }
      this.entry(entry)
    }
  }

  update(update: ThreadUpdate): void {
    if (update.appended && update.entry.seq === this.lastSeq) {
      this.output(update.entry.text)
      this.consumed += update.entry.text.length
      return
    }
    if (update.entry.seq <= this.lastSeq) return
    this.entry(update.entry)
  }

  /** Write any held partial line now. */
  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.pending) this.write(this.pending)
    this.pending = ""
  }

  private entry(entry: ThreadEntry): void {
    this.flush()
    this.lastSeq = entry.seq
    this.consumed = entry.text.length
    const text = sanitizeForTerminal(entry.text)
    if (entry.kind === "output") {
      this.output(entry.text)
    } else if (entry.kind === "tool") {
      this.write(this.style.dim(`▸ ${text.replace(/\n/g, " ")}`))
    } else if (entry.kind === "operator") {
      const [first = "", ...rest] = text.split("\n")
      this.write(this.style.accent(`you ▸ ${first}`))
      for (const line of rest) this.write(this.style.accent(`      ${line}`))
    } else {
      this.write(this.style.dim(`── ${text.replace(/\n/g, " ")} ──`))
    }
  }

  private output(text: string): void {
    const lines = (this.pending + sanitizeForTerminal(text)).split("\n")
    this.pending = lines.pop() ?? ""
    for (const line of lines) this.write(line)
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = this.pending ? setTimeout(() => this.flush(), PARTIAL_LINE_FLUSH_MS) : null
  }
}
