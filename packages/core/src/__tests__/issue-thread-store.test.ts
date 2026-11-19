import { describe, expect, test, vi } from "vitest"
import { applyThreadUpdate, type ThreadEntry, type ThreadUpdate } from "../domain/issue-thread"
import {
  IssueThreadStore,
  MAX_THREAD_ENTRIES,
  MAX_THREAD_ENTRY_CHARS,
  MAX_THREADS,
  OUTPUT_COALESCE_WINDOW_MS,
} from "../orchestrator/issue-thread-store"

function clockedStore() {
  let now = Date.parse("2026-01-01T00:00:00.000Z")
  const store = new IssueThreadStore(() => now)
  return {
    store,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe("IssueThreadStore.append", () => {
  test("records entries in order with increasing seq and the attempt that produced them", () => {
    const { store } = clockedStore()
    store.append("AV-1", "system", "Started claude")
    store.append("AV-1", "output", "Reading the issue", "att-1")
    store.append("AV-1", "operator", "use bun", "att-1")

    expect(store.read("AV-1")).toEqual([
      { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "system", text: "Started claude" },
      { seq: 2, at: "2026-01-01T00:00:00.000Z", kind: "output", text: "Reading the issue", attemptId: "att-1" },
      { seq: 3, at: "2026-01-01T00:00:00.000Z", kind: "operator", text: "use bun", attemptId: "att-1" },
    ])
  })

  test("ignores an empty issue key or empty text", () => {
    const { store } = clockedStore()
    store.append("", "output", "orphan")
    store.append("AV-1", "output", "")
    expect(store.read("")).toEqual([])
    expect(store.read("AV-1")).toEqual([])
  })

  test("joins output deltas that arrive in quick succession into one entry", () => {
    const { store, advance } = clockedStore()
    store.append("AV-1", "output", "Hel", "att-1")
    advance(50)
    store.append("AV-1", "output", "lo", "att-1")

    expect(store.read("AV-1").map((entry) => entry.text)).toEqual(["Hello"])
  })

  test("starts a new entry after a pause, for another attempt, or for another kind", () => {
    const { store, advance } = clockedStore()
    store.append("AV-1", "output", "first", "att-1")
    advance(OUTPUT_COALESCE_WINDOW_MS + 1)
    store.append("AV-1", "output", "second", "att-1")
    store.append("AV-1", "output", "other attempt", "att-2")
    store.append("AV-1", "tool", "Bash: bun test", "att-2")
    store.append("AV-1", "tool", "Read: a.ts", "att-2")

    expect(store.read("AV-1").map((entry) => entry.text)).toEqual([
      "first",
      "second",
      "other attempt",
      "Bash: bun test",
      "Read: a.ts",
    ])
  })

  test("caps one entry's text and opens a new entry when streamed output would exceed the cap", () => {
    const { store } = clockedStore()
    store.append("AV-1", "output", "x".repeat(MAX_THREAD_ENTRY_CHARS + 50), "att-1")
    store.append("AV-1", "output", "tail", "att-1")

    const entries = store.read("AV-1")
    expect(entries).toHaveLength(2)
    expect(entries[0]?.text).toHaveLength(MAX_THREAD_ENTRY_CHARS)
    expect(entries[1]?.text).toBe("tail")
  })

  test("keeps only the newest entries of a long thread", () => {
    const { store } = clockedStore()
    for (let i = 1; i <= MAX_THREAD_ENTRIES + 5; i++) store.append("AV-1", "tool", `call ${i}`)

    const entries = store.read("AV-1")
    expect(entries).toHaveLength(MAX_THREAD_ENTRIES)
    expect(entries[0]?.text).toBe("call 6")
    expect(entries.at(-1)?.seq).toBe(MAX_THREAD_ENTRIES + 5)
  })

  test("read returns copies the caller cannot use to alter the thread", () => {
    const { store } = clockedStore()
    store.append("AV-1", "output", "original", "att-1")
    const [entry] = store.read("AV-1")
    if (entry) entry.text = "tampered"
    expect(store.read("AV-1")[0]?.text).toBe("original")
  })
})

describe("IssueThreadStore.subscribe", () => {
  test("delivers new entries and streamed deltas, then stops after unsubscribe", () => {
    const { store } = clockedStore()
    const updates: ThreadUpdate[] = []
    const unsubscribe = store.subscribe("AV-1", (update) => updates.push(update))

    store.append("AV-1", "output", "Hel", "att-1")
    store.append("AV-1", "output", "lo", "att-1")
    store.append("AV-2", "output", "another issue", "att-9")
    unsubscribe()
    store.append("AV-1", "system", "Completed")

    expect(updates).toEqual([
      {
        issueKey: "AV-1",
        appended: false,
        entry: { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "output", text: "Hel", attemptId: "att-1" },
      },
      {
        issueKey: "AV-1",
        appended: true,
        entry: { seq: 1, at: "2026-01-01T00:00:00.000Z", kind: "output", text: "lo", attemptId: "att-1" },
      },
    ])
  })

  test("a failing listener does not break the writer or other listeners", () => {
    const { store } = clockedStore()
    const healthy = vi.fn()
    store.subscribe("AV-1", () => {
      throw new Error("viewer crashed")
    })
    store.subscribe("AV-1", healthy)

    expect(() => store.append("AV-1", "output", "still flowing", "att-1")).not.toThrow()
    expect(healthy).toHaveBeenCalledTimes(1)
    expect(store.read("AV-1")).toHaveLength(1)
  })

  test("a watcher that subscribed before the first entry sees it arrive", () => {
    const { store } = clockedStore()
    const listener = vi.fn()
    store.subscribe("AV-7", listener)
    store.append("AV-7", "system", "Started codex")
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("IssueThreadStore retention", () => {
  test("drops the least recently used unwatched thread beyond the thread limit", () => {
    const { store } = clockedStore()
    for (let i = 0; i < MAX_THREADS; i++) store.append(`AV-${i}`, "system", "Started claude")
    store.append("AV-0", "system", "Completed") // AV-0 becomes most recent; AV-1 is now the oldest
    store.append("AV-new", "system", "Started claude")

    expect(store.read("AV-1")).toEqual([])
    expect(store.read("AV-0")).toHaveLength(2)
    expect(store.read("AV-new")).toHaveLength(1)
  })

  test("never drops a watched thread, and keeps the thread being created when all others are watched", () => {
    const { store } = clockedStore()
    const listeners = Array.from({ length: MAX_THREADS }, (_, i) => {
      const listener = vi.fn()
      store.subscribe(`AV-${i}`, listener)
      return listener
    })
    const late = vi.fn()
    store.subscribe("AV-late", late)

    store.append("AV-0", "system", "Started claude")
    store.append("AV-late", "system", "Started claude")

    expect(listeners[0]).toHaveBeenCalledTimes(1)
    expect(late).toHaveBeenCalledTimes(1)
    expect(store.read("AV-late")).toHaveLength(1)
  })

  test("forgets an empty thread once its last watcher leaves", () => {
    const { store } = clockedStore()
    const unsubscribe = store.subscribe("AV-1", () => {})
    unsubscribe()
    // Filling to the limit must not evict anything: the empty thread no longer counts.
    for (let i = 0; i < MAX_THREADS; i++) store.append(`KEEP-${i}`, "system", "Started claude")
    expect(store.read("KEEP-0")).toHaveLength(1)
  })
})

describe("applyThreadUpdate", () => {
  const first: ThreadEntry = { seq: 1, at: "t", kind: "output", text: "Hel", attemptId: "att-1" }

  test("extends the tail entry on an append and leaves the input untouched", () => {
    const before = [first]
    const after = applyThreadUpdate(before, { issueKey: "AV-1", appended: true, entry: { ...first, text: "lo" } })
    expect(after).toEqual([{ ...first, text: "Hello" }])
    expect(before[0]?.text).toBe("Hel")
  })

  test("adds a new entry, including an append for an entry this client never saw", () => {
    const next: ThreadEntry = { seq: 2, at: "t", kind: "system", text: "Completed" }
    expect(applyThreadUpdate([first], { issueKey: "AV-1", appended: false, entry: next })).toEqual([first, next])
    expect(applyThreadUpdate([], { issueKey: "AV-1", appended: true, entry: { ...first, text: "lo" } })).toEqual([
      { ...first, text: "lo" },
    ])
  })

  test("keeps the newest entries within the limit", () => {
    const entries = [1, 2, 3].map((seq) => ({ ...first, seq }))
    const result = applyThreadUpdate(entries, { issueKey: "AV-1", appended: false, entry: { ...first, seq: 4 } }, 3)
    expect(result.map((entry) => entry.seq)).toEqual([2, 3, 4])
  })
})
