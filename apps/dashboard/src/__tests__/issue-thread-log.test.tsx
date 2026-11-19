import type { ThreadEntry } from "@agent-valley/core/domain/issue-thread"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { InterventionPanel } from "../features/orchestrator/components/intervention-panel"
import { IssueThreadLog } from "../features/orchestrator/components/issue-thread-log"
import { useIssueThread } from "../features/orchestrator/utils/use-issue-thread"

/** Minimal EventSource stand-in: tests push server events into the newest instance. */
class FakeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  static instances: FakeEventSource[] = []

  readyState = FakeEventSource.CONNECTING
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private listeners = new Map<string, Array<(event: MessageEvent) => void>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close() {
    this.closed = true
  }

  open() {
    this.readyState = FakeEventSource.OPEN
    this.onopen?.()
  }

  emit(type: string, data: unknown) {
    const payload = typeof data === "string" ? data : JSON.stringify(data)
    for (const listener of this.listeners.get(type) ?? []) listener({ data: payload } as MessageEvent)
  }

  fail(readyState: number) {
    this.readyState = readyState
    this.onerror?.()
  }
}

function latestSource(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1)
  if (!source) throw new Error("Expected the hook to open an EventSource")
  return source
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  FakeEventSource.instances = []
})

const entry = (seq: number, kind: ThreadEntry["kind"], text: string): ThreadEntry => ({
  seq,
  at: "2026-01-01T00:00:00.000Z",
  kind,
  text,
  attemptId: "att-1",
})

describe("IssueThreadLog", () => {
  test("renders actor output, tool calls, operator messages and lifecycle markers in order", () => {
    render(
      <IssueThreadLog
        status="open"
        entries={[
          entry(1, "system", "Started codex"),
          entry(2, "tool", "Bash: bun test"),
          entry(3, "output", "Tests are green."),
          entry(4, "operator", "also update README"),
        ]}
      />,
    )

    const log = screen.getByRole("log", { name: "Actor activity" })
    expect(log.textContent).toMatch(
      /Started codex[\s\S]*Bash: bun test[\s\S]*Tests are green\.[\s\S]*also update README/,
    )
    expect(screen.getByText("Operator:")).toBeTruthy()
    expect(screen.getByText("Tool:")).toBeTruthy()
    expect(screen.queryByRole("status")).toBeNull()
  })

  test("explains an empty thread and a thread that is not connected", () => {
    const { rerender } = render(<IssueThreadLog status="connecting" entries={[]} />)
    expect(screen.getByText(/No activity yet/)).toBeTruthy()
    expect(screen.getByRole("status").textContent).toContain("Connecting")

    rerender(<IssueThreadLog status="reconnecting" entries={[]} />)
    expect(screen.getByRole("status").textContent).toContain("Reconnecting")

    rerender(<IssueThreadLog status="closed" entries={[]} />)
    expect(screen.getByRole("status").textContent).toContain("unavailable")
  })

  test("follows new entries until the reader scrolls up, then leaves the scroll position alone", () => {
    const { rerender } = render(<IssueThreadLog status="open" entries={[entry(1, "output", "one")]} />)
    const log = screen.getByRole("log")
    Object.defineProperties(log, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    })

    rerender(<IssueThreadLog status="open" entries={[entry(1, "output", "one"), entry(2, "output", "two")]} />)
    expect(log.scrollTop).toBe(1_000)

    log.scrollTop = 100 // reader scrolled up into history
    fireEvent.scroll(log)
    rerender(
      <IssueThreadLog
        status="open"
        entries={[entry(1, "output", "one"), entry(2, "output", "two"), entry(3, "output", "three")]}
      />,
    )
    expect(log.scrollTop).toBe(100)
  })
})

describe("useIssueThread", () => {
  test("loads the backlog, applies live entries and appends, and closes the stream on unmount", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result, unmount } = renderHook(() => useIssueThread("owner/repo#12"))
    const source = latestSource()
    expect(source.url).toBe("/api/thread?issue=owner%2Frepo%2312")
    expect(result.current.status).toBe("connecting")

    act(() => {
      source.open()
      source.emit("backlog", { issueKey: "owner/repo#12", entries: [entry(1, "system", "Started codex")] })
      source.emit("entry", { issueKey: "owner/repo#12", appended: false, entry: entry(2, "output", "Hel") })
      source.emit("entry", { issueKey: "owner/repo#12", appended: true, entry: entry(2, "output", "lo") })
      source.emit("entry", "{ not json")
      source.emit("backlog", "{ not json")
    })

    expect(result.current.status).toBe("open")
    expect(result.current.entries.map((item) => item.text)).toEqual(["Started codex", "Hello"])

    unmount()
    expect(source.closed).toBe(true)
  })

  test("distinguishes a dropped connection from a refused one", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result } = renderHook(() => useIssueThread("AV-1"))

    act(() => latestSource().fail(FakeEventSource.CONNECTING))
    expect(result.current.status).toBe("reconnecting")

    act(() => latestSource().fail(FakeEventSource.CLOSED))
    expect(result.current.status).toBe("closed")
  })

  test("switching issues drops the previous thread and opens a new stream", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const { result, rerender } = renderHook(({ issueKey }) => useIssueThread(issueKey), {
      initialProps: { issueKey: "AV-1" as string | null },
    })
    const first = latestSource()
    act(() => first.emit("backlog", { issueKey: "AV-1", entries: [entry(1, "output", "from AV-1")] }))

    rerender({ issueKey: "AV-2" })
    expect(first.closed).toBe(true)
    expect(result.current.entries).toEqual([])
    expect(latestSource().url).toBe("/api/thread?issue=AV-2")

    rerender({ issueKey: null })
    expect(FakeEventSource.instances).toHaveLength(2)
  })
})

describe("InterventionPanel thread and composer", () => {
  const attempt = { attemptId: "att-1", issueKey: "PROJ-1", agentType: "claude" }

  test("shows the issue's live thread inside the drawer", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    render(<InterventionPanel attempt={attempt} onClose={() => {}} />)

    act(() => {
      latestSource().open()
      latestSource().emit("backlog", { issueKey: "PROJ-1", entries: [entry(1, "output", "Reading the issue")] })
    })

    expect(screen.getByRole("log", { name: "Actor activity" }).textContent).toContain("Reading the issue")
  })

  test("Enter sends the message, Shift+Enter and IME composition do not", async () => {
    const post = vi.fn(async () => ({ ok: true }))
    render(<InterventionPanel attempt={attempt} onClose={() => {}} post={post} />)
    const input = screen.getByLabelText("Append prompt") as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: "테스트도 추가해줘" } })
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true })
    fireEvent.keyDown(input, { key: "Enter", isComposing: true })
    expect(post).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith({
      attemptId: "att-1",
      command: { kind: "append_prompt", text: "테스트도 추가해줘" },
    })
    await waitFor(() => expect(input.value).toBe(""))
  })

  test("keeps the draft, focus and thread when the run restarts under a new attempt", () => {
    vi.stubGlobal("EventSource", FakeEventSource)
    const onClose = () => {} // stable, as the page's useCallback handler is
    const { rerender } = render(<InterventionPanel attempt={attempt} onClose={onClose} />)
    const input = screen.getByLabelText("Append prompt") as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: "next instruction" } })
    input.focus()

    rerender(<InterventionPanel attempt={{ ...attempt, attemptId: "att-2" }} onClose={onClose} />)

    expect(input.value).toBe("next instruction")
    expect(document.activeElement).toBe(input)
    expect(FakeEventSource.instances).toHaveLength(1)
  })

  test("disables every control and says why while the issue has no running attempt", () => {
    render(<InterventionPanel attempt={attempt} onClose={() => {}} live={false} />)

    expect((screen.getByRole("button", { name: "Abort" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText("Append prompt") as HTMLTextAreaElement).disabled).toBe(true)
    expect(screen.getByText(/No run is active for this issue/)).toBeTruthy()
  })
})
