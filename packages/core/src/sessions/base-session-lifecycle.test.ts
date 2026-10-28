import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentConfig } from "./agent-session"
import { BaseSession } from "./base-session"

const denied = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" })
const gone = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })

class LifecycleSession extends BaseSession {
  constructor(proc: ChildProcess) {
    super()
    this.config = { type: "fixture", timeout: 90, workspacePath: "/offline" }
    this.process = proc
  }

  async start(config: AgentConfig): Promise<void> {
    this.config = config
  }

  async execute(): Promise<void> {}

  get configured(): boolean {
    return this.config !== null
  }
}

function fixture() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 987654,
    exitCode: null,
    signalCode: null,
    stdin: null,
    stderr: null,
    kill: vi.fn(),
  }) as unknown as ChildProcess
  const session = new LifecycleSession(proc)
  const reap = () => {
    Object.assign(proc, { exitCode: 0 })
    proc.emit("exit", 0, null)
  }
  return { proc, session, reap }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.skipIf(process.platform === "win32")("BaseSession process reaping", () => {
  it("joins root exit before kill completes and shares cleanup with dispose", async () => {
    const signal = vi.spyOn(process, "kill").mockReturnValue(true)
    const { proc, session, reap } = fixture()
    let finished = false
    const killed = session.kill().then(() => {
      finished = true
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    const disposed = session.dispose()
    reap()
    await Promise.all([killed, disposed])
    expect(signal.mock.calls).toEqual([[-987654, "SIGKILL"]])
    expect(proc.listenerCount("exit")).toBe(0)
    expect(proc.listenerCount("close")).toBe(0)
    expect(session.pid).toBeUndefined()
  })

  it("retries zombie-group EPERM after the root is reaped without waiting for pipe close", async () => {
    const original = denied()
    const { proc, session, reap } = fixture()
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (proc.exitCode === null) throw original
      throw gone()
    })
    const disposed = session.dispose()
    const outcome = disposed.then(
      () => "disposed",
      (error: unknown) => error,
    )
    reap()
    expect(await outcome).toBe("disposed")
    expect(session.pid).toBeUndefined()
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it.each(["live", "uninspectable"] as const)(
    "preserves original denial for a %s group after root exit",
    async (state) => {
      const original = denied()
      const { session, reap, proc } = fixture()
      vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
        if (signal === 0 && proc.exitCode !== null && state === "live") return true
        throw original
      })
      const outcome = session.dispose().catch((error: unknown) => error)
      reap()
      expect(await outcome).toBe(original)
      expect(session.pid).toBe(987654)
      expect(session.configured).toBe(true)
    },
  )

  it("bounds an unreaped EPERM at five seconds and preserves its original error across dispose", async () => {
    vi.useFakeTimers()
    const original = denied()
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw original
    })
    const { proc, session } = fixture()
    let finished = false
    const outcome = session.kill().catch((error: unknown) => {
      finished = true
      return error
    })
    await vi.advanceTimersByTimeAsync(4999)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await outcome).toBe(original)
    expect(await session.dispose().catch((error: unknown) => error)).toBe(original)
    expect(signal.mock.calls).toEqual([
      [-987654, "SIGKILL"],
      [-987654, 0],
    ])
    expect(proc.listenerCount("exit")).toBe(0)
    expect(proc.listenerCount("close")).toBe(0)
    expect(session.pid).toBe(987654)
    expect(session.configured).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("rejects successful signaling without root exit within five seconds", async () => {
    vi.useFakeTimers()
    vi.spyOn(process, "kill").mockReturnValue(true)
    const { proc, session } = fixture()
    let finished = false
    const outcome = session.dispose().catch((error: unknown) => {
      finished = true
      return error
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(finished).toBe(true)
    expect(await outcome).toBeInstanceOf(Error)
    expect(String(await outcome)).toContain("5000ms")
    expect(session.pid).toBe(987654)
    expect(session.configured).toBe(true)
    expect(proc.listenerCount("exit")).toBe(0)
    expect(proc.listenerCount("close")).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("disposes an already reaped root without adding exit listeners", async () => {
    vi.useFakeTimers()
    const { proc, session, reap } = fixture()
    reap()
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw gone()
    })
    await session.dispose()
    expect(session.pid).toBeUndefined()
    expect(proc.listenerCount("exit")).toBe(0)
    expect(proc.listenerCount("close")).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
