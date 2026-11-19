/**
 * /api/thread route tests — auth gate, parameter validation, backlog + live
 * delivery, orchestrator reload, and listener cleanup on disconnect.
 */
import type { ThreadEntry, ThreadUpdate } from "@agent-valley/core/domain/issue-thread"
import { IssueThreadStore } from "@agent-valley/core/orchestrator/issue-thread-store"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let mockOrchestrator: { threads?: Pick<IssueThreadStore, "read" | "subscribe"> } | null = null

vi.mock("@/lib/orchestrator-singleton", () => ({
  getOrchestrator: () => mockOrchestrator,
}))

const { GET: threadGET } = await import("@/app/api/thread/route")

const ENV_KEYS = ["SYMPHONY_DASHBOARD_TOKEN", "SYMPHONY_ALLOW_REMOTE_STATUS"] as const

function localRequest(query: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost:9741/api/thread${query}`, { headers: { host: "localhost:9741" }, ...init })
}

function reader(response: Response) {
  if (!response.body) throw new Error("Expected a readable SSE response body")
  return response.body.getReader()
}

/** Decode the next SSE frame into its event name and JSON payload. */
async function nextEvent(
  stream: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ event: string; data: unknown } | null> {
  const { value, done } = await stream.read()
  if (done || !value) return null
  const frame = new TextDecoder().decode(value)
  const event = /^event: (.+)$/m.exec(frame)?.[1] ?? ""
  const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "null"
  return { event, data: JSON.parse(data) }
}

/** Texts of the entries carried by the next frame, which must be a backlog. */
async function nextBacklogTexts(stream: ReadableStreamDefaultReader<Uint8Array>): Promise<string[]> {
  const frame = await nextEvent(stream)
  if (frame?.event !== "backlog")
    throw new Error(`Expected a backlog event, received ${frame?.event ?? "end of stream"}`)
  return (frame.data as { entries: ThreadEntry[] }).entries.map((entry) => entry.text)
}

describe("GET /api/thread", () => {
  let store: IssueThreadStore

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    store = new IssueThreadStore()
    mockOrchestrator = { threads: store }
    vi.useFakeTimers()
  })

  afterEach(() => {
    for (const key of ENV_KEYS) delete process.env[key]
    mockOrchestrator = null
    vi.useRealTimers()
  })

  test("rejects a remote request when no dashboard token is configured", async () => {
    const response = await threadGET(
      new Request("http://example.com/api/thread?issue=AV-1", { headers: { host: "example.com" } }),
    )
    expect(response.status).toBe(403)
  })

  test("requires the dashboard token once one is configured", async () => {
    process.env.SYMPHONY_DASHBOARD_TOKEN = "status-token"
    expect((await threadGET(localRequest("?issue=AV-1"))).status).toBe(401)

    const allowed = await threadGET(
      localRequest("?issue=AV-1", { headers: { host: "localhost:9741", authorization: "Bearer status-token" } }),
    )
    expect(allowed.status).toBe(200)
    await reader(allowed).cancel()
  })

  test("rejects a missing or oversized issue key with a message that shows the expected form", async () => {
    for (const query of ["", "?issue=", "?issue=%20%20", `?issue=${"x".repeat(201)}`]) {
      const response = await threadGET(localRequest(query))
      expect(response.status).toBe(400)
      expect(((await response.json()) as { message: string }).message).toContain("/api/thread?issue=PROJ-12")
    }
  })

  test("sends the retained thread first, then live entries and streamed appends", async () => {
    store.append("AV-1", "system", "Started codex")
    store.append("AV-2", "system", "Started claude")

    const response = await threadGET(localRequest("?issue=AV-1"))
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    const stream = reader(response)

    expect(await nextBacklogTexts(stream)).toEqual(["Started codex"])

    store.append("AV-1", "output", "Hel", "att-1")
    store.append("AV-2", "output", "not for this stream", "att-2")
    store.append("AV-1", "output", "lo", "att-1")

    const first = (await nextEvent(stream))?.data as ThreadUpdate
    const second = (await nextEvent(stream))?.data as ThreadUpdate
    expect([first.appended, first.entry.text]).toEqual([false, "Hel"])
    expect([second.appended, second.entry.text, second.entry.seq]).toEqual([true, "lo", first.entry.seq])
    await stream.cancel()
  })

  test("accepts an issue key with URL-reserved characters", async () => {
    store.append("owner/repo#12", "system", "Started claude")
    const response = await threadGET(localRequest(`?issue=${encodeURIComponent("owner/repo#12")}`))
    expect(await nextBacklogTexts(reader(response))).toEqual(["Started claude"])
  })

  test("stops listening when the client disconnects", async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    mockOrchestrator = { threads: { read: () => [], subscribe } }

    const stream = reader(await threadGET(localRequest("?issue=AV-1")))
    await stream.read()
    await stream.cancel()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  test("aborting the request releases the listener and the keepalive timer", async () => {
    const unsubscribe = vi.fn()
    mockOrchestrator = { threads: { read: () => [], subscribe: () => unsubscribe } }
    const controller = new AbortController()

    const stream = reader(await threadGET(localRequest("?issue=AV-1", { signal: controller.signal })))
    await stream.read()
    controller.abort()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect((await stream.read()).done).toBe(true)
  })

  test("a request that is already aborted opens nothing", async () => {
    const subscribe = vi.fn(() => () => {})
    mockOrchestrator = { threads: { read: () => [], subscribe } }
    const controller = new AbortController()
    controller.abort()

    const stream = reader(await threadGET(localRequest("?issue=AV-1", { signal: controller.signal })))
    expect((await stream.read()).done).toBe(true)
    expect(subscribe).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  test("reports an unavailable orchestrator, then delivers the thread once it starts", async () => {
    mockOrchestrator = null
    const stream = reader(await threadGET(localRequest("?issue=AV-1")))

    expect(await nextEvent(stream)).toEqual({
      event: "unavailable",
      data: { message: expect.stringContaining("av doctor") },
    })

    store.append("AV-1", "system", "Started codex")
    mockOrchestrator = { threads: store }
    vi.advanceTimersByTime(15_000)

    expect(await nextBacklogTexts(stream)).toEqual(["Started codex"])
    expect((await nextEvent(stream))?.event).toBe("keepalive")
    await stream.cancel()
  })

  test("a hot reload moves the stream to the replacement orchestrator and resends the backlog", async () => {
    const previousUnsubscribe = vi.fn()
    mockOrchestrator = { threads: { read: () => [], subscribe: () => previousUnsubscribe } }
    const stream = reader(await threadGET(localRequest("?issue=AV-1")))
    await stream.read()

    const replacement = new IssueThreadStore()
    replacement.append("AV-1", "system", "Started codex")
    mockOrchestrator = { threads: replacement }
    vi.advanceTimersByTime(15_000)

    expect(previousUnsubscribe).toHaveBeenCalledTimes(1)
    expect(await nextBacklogTexts(stream)).toEqual(["Started codex"])
    await stream.cancel()
  })
})
