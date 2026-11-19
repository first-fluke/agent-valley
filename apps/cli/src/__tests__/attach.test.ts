import { PassThrough, Writable } from "node:stream"
import { Command } from "commander"
import { describe, expect, test, vi } from "vitest"
import { type AttachDeps, parseLines, registerAttachCommand, resolveAttachTarget, runAttach } from "../attach"
import { DashboardRequestError, type ThreadStreamHandlers } from "../attach-client"

const running = (...issues: Array<[key: string, attemptId?: string, agentType?: string]>) => ({
  activeWorkspaces: issues.map(([key, attemptId, agentType]) => ({ key, attemptId, agentType })),
})

/** Strip color codes so assertions read the same with or without a color-capable terminal. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escape character is the point
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

function harness(overrides: Partial<Pick<AttachDeps, "readStatus" | "sendIntervention">> = {}) {
  const input = new PassThrough()
  const written: string[] = []
  const output = new Writable({
    write(chunk, _encoding, done) {
      written.push(String(chunk))
      done()
    },
  })
  const interrupt = new AbortController()
  const streams: ThreadStreamHandlers[] = []
  // By default the thread stream stays open until the session detaches.
  const followThread = vi.fn<AttachDeps["followThread"]>(
    (_port, _issue, handlers, signal) =>
      new Promise<void>((resolve) => {
        streams.push(handlers)
        if (signal.aborted) resolve()
        else signal.addEventListener("abort", () => resolve(), { once: true })
      }),
  )
  const deps = {
    readStatus: vi.fn<AttachDeps["readStatus"]>(
      overrides.readStatus ?? (async () => running(["AV-1", "att-1", "codex"])),
    ),
    followThread,
    sendIntervention: vi.fn<AttachDeps["sendIntervention"]>(overrides.sendIntervention ?? (async () => ({ ok: true }))),
    input,
    output,
    signal: interrupt.signal,
    retryDelayMs: 1,
  }
  const start = (issue?: string, interactive = true) => runAttach(issue, { port: "9741", lines: 30, interactive }, deps)
  return {
    deps,
    input,
    interrupt,
    start,
    text: () => plain(written.join("")),
    /** Handlers of the most recent thread stream, once it is open. */
    stream: async () => {
      await vi.waitFor(() => expect(streams.length).toBeGreaterThan(0))
      return streams[streams.length - 1] as ThreadStreamHandlers
    },
  }
}

describe("resolveAttachTarget", () => {
  test("uses the named issue with its canonical key, running or not", () => {
    expect(resolveAttachTarget(running(["AV-1", "att-1", "codex"]), " av-1 ")).toEqual({
      issueKey: "AV-1",
      active: { issueKey: "AV-1", attemptId: "att-1", agentType: "codex" },
    })
    expect(resolveAttachTarget(running(), "AV-9")).toEqual({ issueKey: "AV-9", active: undefined })
  })

  test("defaults to the only running actor", () => {
    expect(resolveAttachTarget(running(["AV-1", "att-1", "claude"]), undefined)).toMatchObject({ issueKey: "AV-1" })
  })

  test("asks for an issue key when none or several actors are running", () => {
    expect(resolveAttachTarget(running(), undefined)).toEqual({
      error: expect.stringContaining("av attach PROJ-12"),
    })
    const several = resolveAttachTarget(running(["AV-1", "att-1", "codex"], ["AV-2"]), undefined)
    expect(several).toEqual({
      error: expect.stringMatching(/av attach AV-1 {3}\(codex\)\n {2}av attach AV-2 {3}\(starting\)/),
    })
  })
})

describe("parseLines", () => {
  test("accepts a non-negative count and falls back to the default otherwise", () => {
    expect(parseLines("0")).toBe(0)
    expect(parseLines("120")).toBe(120)
    expect(parseLines("-5")).toBe(30)
    expect(parseLines("many")).toBe(30)
  })
})

describe("registerAttachCommand", () => {
  test("adds `attach [issue]` with history and follow-only options", () => {
    const program = new Command()
    registerAttachCommand(program, { root: "/project", pidFile: "/project/.av.pid" })
    const attach = program.commands.find((command) => command.name() === "attach")
    expect(attach?.usage()).toContain("[issue]")
    expect(attach?.options.map((option) => option.long)).toEqual(["--lines", "--no-input"])
  })
})

describe("runAttach — choosing what to attach to", () => {
  test("exits with guidance when the dashboard is not reachable", async () => {
    const h = harness({
      readStatus: async () => {
        throw new TypeError("fetch failed")
      },
    })
    expect(await h.start()).toBe(1)
    expect(h.text()).toContain("Cannot reach the dashboard. Start it with: av up")
    expect(h.deps.followThread).not.toHaveBeenCalled()
  })

  test("passes other status errors through unchanged", async () => {
    const h = harness({
      readStatus: async () => {
        throw new Error("Dashboard denied status (401). Set SYMPHONY_DASHBOARD_TOKEN.")
      },
    })
    expect(await h.start()).toBe(1)
    expect(h.text()).toContain("Set SYMPHONY_DASHBOARD_TOKEN")
  })

  test("exits with the list of running actors when the issue is ambiguous", async () => {
    const h = harness({ readStatus: async () => running(["AV-1", "att-1", "codex"], ["AV-2", "att-2", "claude"]) })
    expect(await h.start()).toBe(1)
    expect(h.text()).toContain("av attach AV-2   (claude)")
  })

  test("waits on an issue that has no run yet", async () => {
    const h = harness({ readStatus: async () => running() })
    const session = h.start("AV-9", false)
    await h.stream()
    h.interrupt.abort()

    expect(await session).toBe(0)
    expect(h.deps.followThread).toHaveBeenCalledWith("9741", "AV-9", expect.anything(), expect.anything())
    expect(h.text()).toContain("Attached to AV-9 · no run is active yet; waiting for activity")
  })

  test("returns at once when the operator already interrupted", async () => {
    const h = harness()
    h.interrupt.abort()
    expect(await h.start()).toBe(0)
  })
})

describe("runAttach — following the thread", () => {
  test("prints the backlog and live activity, then detaches on interrupt", async () => {
    const h = harness()
    const session = h.start(undefined, false)
    const stream = await h.stream()

    stream.onBacklog({ issueKey: "AV-1", entries: [{ seq: 1, at: "t", kind: "system", text: "Started codex" }] })
    stream.onUpdate({
      issueKey: "AV-1",
      appended: false,
      entry: { seq: 2, at: "t", kind: "output", text: "Tests are green." },
    })
    stream.onUnavailable("Orchestrator is unavailable.")
    h.input.write("this line is never read in follow-only mode\n")
    h.interrupt.abort()

    expect(await session).toBe(0)
    const text = h.text()
    expect(text).toContain("Attached to AV-1 · codex")
    expect(text).toContain("── Started codex ──")
    expect(text).toContain("Tests are green.") // partial line flushed on detach
    expect(text).toContain("Orchestrator is unavailable.")
    expect(text).toContain("Detached from AV-1. The actor keeps running.")
    expect(text).not.toContain("Type a message")
    expect(h.deps.sendIntervention).not.toHaveBeenCalled()
  })

  test("reconnects after the stream drops or ends", async () => {
    const h = harness()
    h.deps.followThread.mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValueOnce(undefined)
    const session = h.start(undefined, false)

    await vi.waitFor(() => expect(h.deps.followThread).toHaveBeenCalledTimes(3))
    h.interrupt.abort()

    expect(await session).toBe(0)
    expect(h.text().match(/Thread connection lost\. Reconnecting…/g)).toHaveLength(2)
  })

  test("stops with the dashboard's explanation when the stream is refused", async () => {
    const h = harness()
    h.deps.followThread.mockRejectedValueOnce(
      new DashboardRequestError("Dashboard denied the thread stream (401). Set SYMPHONY_DASHBOARD_TOKEN.", 401),
    )
    expect(await h.start(undefined, false)).toBe(1)
    expect(h.text()).toContain("Set SYMPHONY_DASHBOARD_TOKEN")
    expect(h.deps.followThread).toHaveBeenCalledTimes(1)
  })
})

describe("runAttach — talking to the actor", () => {
  test("sends typed text as a message and slash commands as interventions, in order", async () => {
    const h = harness()
    const session = h.start()
    await h.stream()

    h.input.write("also update README\n/pause\n/abort wrong branch\n\n/quit\n")

    expect(await session).toBe(0)
    expect(h.deps.sendIntervention.mock.calls).toEqual([
      ["9741", "att-1", { kind: "append_prompt", text: "also update README" }],
      ["9741", "att-1", { kind: "pause" }],
      ["9741", "att-1", { kind: "abort", reason: "wrong branch" }],
    ])
    expect(h.text()).toContain("Type a message and press Enter")
  })

  test("targets the attempt that is current when the line is sent", async () => {
    const h = harness()
    h.deps.readStatus
      .mockResolvedValueOnce(running(["AV-1", "att-1", "claude"])) // attach
      .mockResolvedValueOnce(running(["AV-1", "att-1", "claude"])) // first message
      .mockResolvedValueOnce(running(["AV-1", "att-2", "claude"])) // run restarted before the second
    const session = h.start()
    await h.stream()

    h.input.write("first\nsecond\n/quit\n")
    await session

    expect(h.deps.sendIntervention.mock.calls.map(([, attemptId]) => attemptId)).toEqual(["att-1", "att-2"])
  })

  test("does not send while the issue has no running attempt", async () => {
    const h = harness()
    h.deps.readStatus.mockResolvedValueOnce(running(["AV-1", "att-1", "codex"])).mockResolvedValue(running())
    const session = h.start()
    await h.stream()

    h.input.write("anyone there?\n/quit\n")
    await session

    expect(h.deps.sendIntervention).not.toHaveBeenCalled()
    expect(h.text()).toContain("Not sent: no run is active for AV-1 right now.")
  })

  test("does not send a command the agent type cannot honor, and lists what it can", async () => {
    const h = harness({ readStatus: async () => running(["AV-1", "att-1", "qwen"]) })
    const session = h.start()
    await h.stream()

    h.input.write("/pause\nplease stop\n/quit\n")
    await session

    expect(h.deps.sendIntervention).not.toHaveBeenCalled()
    expect(h.text()).toContain("Not sent: qwen does not support /pause. Available: /abort.")
    expect(h.text()).toContain("Not sent: qwen does not support messages. Available: /abort.")
  })

  test("shows why the orchestrator rejected a command", async () => {
    const h = harness({
      sendIntervention: async () => ({ ok: false, message: 'attempt "att-1" is already terminated.' }),
    })
    const session = h.start()
    await h.stream()

    h.input.write("too late\n/quit\n")
    await session

    expect(h.text()).toContain('Not sent. attempt "att-1" is already terminated.')
  })

  test("reports a status lookup failure without ending the session", async () => {
    const h = harness()
    h.deps.readStatus
      .mockResolvedValueOnce(running(["AV-1", "att-1", "codex"]))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
    const session = h.start()
    await h.stream()

    h.input.write("hello\nhello again\n/quit\n")
    await session

    expect(h.text()).toContain("Not sent. Cannot reach the dashboard. Start it with: av up")
    expect(h.deps.sendIntervention).toHaveBeenCalledTimes(1)
  })

  test("answers /help and names an unknown command", async () => {
    const h = harness()
    const session = h.start()
    await h.stream()

    h.input.write("/help\n/explode\n/quit\n")
    await session

    expect(h.text()).toContain("/abort [reason]")
    expect(h.text()).toContain("Unknown command /explode. Type /help for the list.")
    expect(h.deps.sendIntervention).not.toHaveBeenCalled()
  })

  test("end of input detaches after queued lines were delivered", async () => {
    const h = harness()
    const session = h.start()
    await h.stream()

    h.input.end("piped instruction\n")

    expect(await session).toBe(0)
    expect(h.deps.sendIntervention).toHaveBeenCalledWith("9741", "att-1", {
      kind: "append_prompt",
      text: "piped instruction",
    })
  })
})
