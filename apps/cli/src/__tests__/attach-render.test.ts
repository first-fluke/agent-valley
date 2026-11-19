import type { ThreadEntry } from "@agent-valley/core/domain/issue-thread"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  ATTACH_HELP,
  PARTIAL_LINE_FLUSH_MS,
  parseAttachInput,
  sanitizeForTerminal,
  ThreadPrinter,
} from "../attach-render"

const entry = (seq: number, kind: ThreadEntry["kind"], text: string): ThreadEntry => ({
  seq,
  at: "2026-01-01T00:00:00.000Z",
  kind,
  text,
  attemptId: "att-1",
})

describe("parseAttachInput", () => {
  test("plain text is a message to the actor", () => {
    expect(parseAttachInput("  also update README  ")).toEqual({ type: "message", text: "also update README" })
  })

  test("blank input is ignored", () => {
    expect(parseAttachInput("   ")).toEqual({ type: "empty" })
  })

  test("slash commands map to intervention commands", () => {
    expect(parseAttachInput("/pause")).toEqual({ type: "command", command: { kind: "pause" } })
    expect(parseAttachInput("/RESUME")).toEqual({ type: "command", command: { kind: "resume" } })
    expect(parseAttachInput("/abort wrong branch")).toEqual({
      type: "command",
      command: { kind: "abort", reason: "wrong branch" },
    })
    expect(parseAttachInput("/abort")).toEqual({
      type: "command",
      command: { kind: "abort", reason: "operator_requested" },
    })
  })

  test("quit, help, and unknown commands are recognized", () => {
    for (const quit of ["/quit", "/exit", "/q"]) expect(parseAttachInput(quit)).toEqual({ type: "quit" })
    for (const help of ["/help", "/?"]) expect(parseAttachInput(help)).toEqual({ type: "help" })
    expect(parseAttachInput("/explode now")).toEqual({ type: "unknown", name: "explode" })
    expect(parseAttachInput("/")).toEqual({ type: "unknown", name: "" })
  })

  test("a doubled slash sends a message that starts with a slash", () => {
    expect(parseAttachInput("//api/users returns 500")).toEqual({ type: "message", text: "/api/users returns 500" })
  })

  test("the help text documents every command the parser accepts", () => {
    for (const command of ["/pause", "/resume", "/abort", "/quit", "//text"]) expect(ATTACH_HELP).toContain(command)
  })
})

describe("sanitizeForTerminal", () => {
  test("removes escape sequences that would restyle or rewrite the terminal", () => {
    expect(sanitizeForTerminal("\x1b[31mred\x1b[0m plain")).toBe("red plain")
    expect(sanitizeForTerminal("before\x1b[2J\x1b[Hafter")).toBe("beforeafter")
    expect(sanitizeForTerminal("title\x1b]0;pwned\x07 done")).toBe("title done")
    expect(sanitizeForTerminal("lone\x1b escape\x1b[")).toBe("lone escape")
  })

  test("removes control characters but keeps newlines, tabs, and non-ASCII text", () => {
    expect(sanitizeForTerminal("a\x00b\x07c\x08d\x7f")).toBe("abcd")
    expect(sanitizeForTerminal("line1\r\nline2\rline3\n\tindented")).toBe("line1\nline2\nline3\n\tindented")
    expect(sanitizeForTerminal("테스트 통과 ✓")).toBe("테스트 통과 ✓")
  })
})

describe("ThreadPrinter", () => {
  let lines: string[]
  let printer: ThreadPrinter

  beforeEach(() => {
    vi.useFakeTimers()
    lines = []
    printer = new ThreadPrinter((line) => lines.push(line), { dim: (t) => `<${t}>`, accent: (t) => `[${t}]` })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test("formats each kind of entry on its own lines", () => {
    printer.backlog({
      issueKey: "AV-1",
      entries: [
        entry(1, "system", "Started codex"),
        entry(2, "tool", "Bash: bun test"),
        entry(3, "output", "Tests are green.\n"),
        entry(4, "operator", "also update README\nand the changelog"),
      ],
    })

    expect(lines).toEqual([
      "<── Started codex ──>",
      "<▸ Bash: bun test>",
      "Tests are green.",
      "[you ▸ also update README]",
      "[      and the changelog]",
    ])
  })

  test("assembles streamed fragments into whole lines", () => {
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(1, "output", "Run") })
    printer.update({ issueKey: "AV-1", appended: true, entry: entry(1, "output", "ning tests\nAll") })
    expect(lines).toEqual(["Running tests"])

    printer.update({ issueKey: "AV-1", appended: true, entry: entry(1, "output", " green\n") })
    expect(lines).toEqual(["Running tests", "All green"])
  })

  test("shows a partial line after a pause, and before the next entry", () => {
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(1, "output", "thinking") })
    expect(lines).toEqual([])
    vi.advanceTimersByTime(PARTIAL_LINE_FLUSH_MS)
    expect(lines).toEqual(["thinking"])

    printer.update({ issueKey: "AV-1", appended: false, entry: entry(2, "output", "unfinished") })
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(3, "system", "Completed") })
    expect(lines).toEqual(["thinking", "unfinished", "<── Completed ──>"])
    expect(vi.getTimerCount()).toBe(0)
  })

  test("strips terminal escapes from actor output and tool lines", () => {
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(1, "output", "\x1b[2Jwiped?\n") })
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(2, "tool", "Bash: echo\n\x1b[31mhi") })
    expect(lines).toEqual(["wiped?", "<▸ Bash: echo hi>"])
  })

  test("limits the first backlog to the newest entries and says how many were left out", () => {
    printer.backlog({ issueKey: "AV-1", entries: [1, 2, 3, 4].map((seq) => entry(seq, "tool", `call ${seq}`)) }, 2)
    expect(lines).toEqual(["<… 2 earlier entries not shown>", "<▸ call 3>", "<▸ call 4>"])

    lines.length = 0
    new ThreadPrinter((line) => lines.push(line)).backlog(
      { issueKey: "AV-1", entries: [entry(1, "tool", "a"), entry(2, "tool", "b")] },
      1,
    )
    expect(lines).toEqual(["… 1 earlier entry not shown", "▸ b"])
  })

  test("a resent backlog prints only what is new, including the rest of a streamed entry", () => {
    printer.backlog({ issueKey: "AV-1", entries: [entry(1, "system", "Started codex"), entry(2, "output", "Hel")] })
    printer.backlog({
      issueKey: "AV-1",
      entries: [entry(1, "system", "Started codex"), entry(2, "output", "Hello\n"), entry(3, "system", "Completed")],
    })
    // A live update the reconnect already covered is not printed twice.
    printer.update({ issueKey: "AV-1", appended: false, entry: entry(3, "system", "Completed") })

    expect(lines).toEqual(["<── Started codex ──>", "Hello", "<── Completed ──>"])
  })

  test("starts over when the orchestrator restarted and sequence numbers went backwards", () => {
    printer.backlog({ issueKey: "AV-1", entries: [entry(7, "system", "Started codex"), entry(8, "output", "old")] })
    printer.backlog({ issueKey: "AV-1", entries: [entry(1, "system", "Started claude")] })

    expect(lines).toEqual(["<── Started codex ──>", "old", "<── Started claude ──>"])
  })

  test("an append for an entry that was never seen is shown as a new entry", () => {
    printer.update({ issueKey: "AV-1", appended: true, entry: entry(5, "output", "mid-stream\n") })
    expect(lines).toEqual(["mid-stream"])
  })
})
