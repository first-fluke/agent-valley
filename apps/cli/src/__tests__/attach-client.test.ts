import type { ThreadBacklog, ThreadUpdate } from "@agent-valley/core/domain/issue-thread"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  createSseParser,
  DashboardRequestError,
  findActiveIssue,
  followThread,
  listActiveIssues,
  type SseEvent,
  sendIntervention,
} from "../attach-client"
import { dashboardUrl } from "../status-client"

const ENV_KEYS = ["SYMPHONY_DASHBOARD_TOKEN", "SYMPHONY_INTERVENTION_TOKEN", "SYMPHONY_DASHBOARD_HOST"] as const
const saved = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame))
        controller.close()
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function recorder() {
  const backlogs: ThreadBacklog[] = []
  const updates: ThreadUpdate[] = []
  const unavailable: string[] = []
  return {
    backlogs,
    updates,
    unavailable,
    handlers: {
      onBacklog: (backlog: ThreadBacklog) => backlogs.push(backlog),
      onUpdate: (update: ThreadUpdate) => updates.push(update),
      onUnavailable: (message: string) => unavailable.push(message),
    },
  }
}

describe("dashboardUrl", () => {
  test("targets loopback by default and brackets an IPv6 host", () => {
    expect(dashboardUrl("9741", "/api/status")).toBe("http://127.0.0.1:9741/api/status")
    process.env.SYMPHONY_DASHBOARD_HOST = "::1"
    expect(dashboardUrl("9741", "/api/thread?issue=AV-1")).toBe("http://[::1]:9741/api/thread?issue=AV-1")
  })
})

describe("active issues from /api/status", () => {
  const status = {
    activeWorkspaces: [
      { key: "AV-1", attemptId: "att-1", agentType: "codex" },
      { key: "AV-2" },
      { key: "", attemptId: "att-x" },
      null,
      "junk",
    ],
  }

  test("lists running issues and skips malformed rows", () => {
    expect(listActiveIssues(status)).toEqual([
      { issueKey: "AV-1", attemptId: "att-1", agentType: "codex" },
      { issueKey: "AV-2", attemptId: undefined, agentType: undefined },
    ])
    expect(listActiveIssues({})).toEqual([])
  })

  test("finds an issue regardless of the case it was typed in", () => {
    expect(findActiveIssue(status, "av-1")?.attemptId).toBe("att-1")
    expect(findActiveIssue(status, "AV-9")).toBeUndefined()
  })
})

describe("createSseParser", () => {
  test("emits events split across chunks, with CRLF, multi-line data, and comments", () => {
    const events: SseEvent[] = []
    const push = createSseParser((event) => events.push(event))

    push("event: back")
    push('log\ndata: {"a":1}\n\n: keepalive\n\n')
    push("data: line one\r\ndata: line two\r\n\r\n")
    push("event: orphan\n\n")
    push("id: 7\nevent: entry\ndata:{}\n")
    expect(events).toEqual([
      { event: "backlog", data: '{"a":1}' },
      { event: "message", data: "line one\nline two" },
    ])

    push("\n")
    expect(events.at(-1)).toEqual({ event: "entry", data: "{}" })
  })
})

describe("followThread", () => {
  test("requests the issue's stream with the dashboard token and delivers its events", async () => {
    process.env.SYMPHONY_DASHBOARD_TOKEN = "status-token"
    const entry = { seq: 2, at: "t", kind: "output", text: "hi" }
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        'event: backlog\ndata: {"issueKey":"owner/repo#12","entries":[]}\n\n',
        `event: entry\ndata: ${JSON.stringify({ issueKey: "owner/repo#12", appended: false, entry })}\n\n`,
        'event: unavailable\ndata: {"message":"Orchestrator is unavailable."}\n\n',
        "event: entry\ndata: { not json\n\n",
        "event: keepalive\ndata: null\n\n",
      ]),
    )
    const seen = recorder()

    await followThread("9741", "owner/repo#12", seen.handlers, new AbortController().signal, fetchImpl as never)

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:9741/api/thread?issue=owner%2Frepo%2312")
    expect(init.headers).toMatchObject({ Authorization: "Bearer status-token", Accept: "text/event-stream" })
    expect(seen.backlogs).toEqual([{ issueKey: "owner/repo#12", entries: [] }])
    expect(seen.updates.map((update) => update.entry.text)).toEqual(["hi"])
    expect(seen.unavailable).toEqual(["Orchestrator is unavailable."])
  })

  test("sends no Authorization header when no token is configured", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([]))
    await followThread("9741", "AV-1", recorder().handlers, new AbortController().signal, fetchImpl as never)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).not.toHaveProperty("Authorization")
  })

  test("explains a denied stream with the variable to set", async () => {
    const fetchImpl = async () => Response.json({ message: "Log in to the dashboard." }, { status: 401 })
    const failure = followThread("9741", "AV-1", recorder().handlers, new AbortController().signal, fetchImpl as never)
    await expect(failure).rejects.toThrow(DashboardRequestError)
    await expect(failure).rejects.toThrow(/SYMPHONY_DASHBOARD_TOKEN.*Log in to the dashboard\./)
  })

  test("explains any other refusal, such as a dashboard that predates the thread endpoint", async () => {
    const fetchImpl = async () => new Response("not found", { status: 404 })
    const failure = followThread("9741", "AV-1", recorder().handlers, new AbortController().signal, fetchImpl as never)
    await expect(failure).rejects.toMatchObject({ status: 404 })
    await expect(failure).rejects.toThrow(/av down && av up/)
  })

  test("returns quietly when aborted before or during the stream, and rethrows other failures", async () => {
    const controller = new AbortController()
    const rejectingFetch = async () => {
      throw new Error("socket closed")
    }
    await expect(
      followThread("9741", "AV-1", recorder().handlers, controller.signal, rejectingFetch as never),
    ).rejects.toThrow("socket closed")

    const brokenBody = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error("stream reset")
          },
        }),
        { status: 200 },
      )
    await expect(
      followThread("9741", "AV-1", recorder().handlers, controller.signal, (async () => brokenBody()) as never),
    ).rejects.toThrow("stream reset")

    controller.abort()
    await expect(
      followThread("9741", "AV-1", recorder().handlers, controller.signal, rejectingFetch as never),
    ).resolves.toBeUndefined()
    await expect(
      followThread("9741", "AV-1", recorder().handlers, controller.signal, (async () => brokenBody()) as never),
    ).resolves.toBeUndefined()
  })
})

describe("sendIntervention", () => {
  test("posts the command as a same-origin request, with the intervention token when set", async () => {
    process.env.SYMPHONY_INTERVENTION_TOKEN = "control-token"
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }))

    const outcome = await sendIntervention(
      "9741",
      "att-1",
      { kind: "append_prompt", text: "add tests" },
      fetchImpl as never,
    )

    expect(outcome).toEqual({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("http://127.0.0.1:9741/api/intervention")
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      Origin: "http://127.0.0.1:9741",
      Authorization: "Bearer control-token",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(String(init.body))).toEqual({
      attemptId: "att-1",
      command: { kind: "append_prompt", text: "add tests" },
    })
  })

  test("relays the orchestrator's explanation when a command is rejected", async () => {
    const fetchImpl = async () =>
      Response.json(
        { ok: false, reason: "unsupported", message: 'agent "qwen" does not support "pause"' },
        { status: 422 },
      )
    expect(await sendIntervention("9741", "att-1", { kind: "pause" }, fetchImpl as never)).toEqual({
      ok: false,
      message: 'agent "qwen" does not support "pause"',
    })
  })

  test("falls back to the status code when the rejection carries no message", async () => {
    const fetchImpl = async () => new Response("oops", { status: 500 })
    expect(await sendIntervention("9741", "att-1", { kind: "pause" }, fetchImpl as never)).toEqual({
      ok: false,
      message: "Command failed (500).",
    })
  })

  test("names the token to set when the dashboard denies the command", async () => {
    const fetchImpl = async () => Response.json({ message: "intervention is local-only." }, { status: 403 })
    const outcome = await sendIntervention("9741", "att-1", { kind: "pause" }, fetchImpl as never)
    expect(outcome.ok).toBe(false)
    expect(outcome.ok ? "" : outcome.message).toMatch(/SYMPHONY_INTERVENTION_TOKEN.*intervention is local-only\./)
  })

  test("reports an unreachable dashboard instead of throwing", async () => {
    const fetchImpl = async () => {
      throw new Error("connect ECONNREFUSED")
    }
    const outcome = await sendIntervention("9741", "att-1", { kind: "pause" }, fetchImpl as never)
    expect(outcome.ok ? "" : outcome.message).toMatch(/Could not reach the dashboard.*av up/)
  })
})
