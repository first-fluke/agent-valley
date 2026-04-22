/**
 * ngrok adapter tests — verify URL extraction, graceful degrade when the
 * binary is missing, and kill() idempotency.
 *
 * `child_process` is module-mocked so tests never touch a real `ngrok`
 * binary. The mock exposes a fake EventEmitter-style ChildProcess we
 * drive directly from each test case.
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ── Mock child_process ───────────────────────────────────────────────
// Hoisted via vi.mock(). Each test replaces spawnSyncReturnValue and
// lastSpawn before invoking the adapter.

type WhichStatus = 0 | 1

const state: {
  whichStatus: WhichStatus
  lastSpawn: FakeChildProcess | null
  spawnArgs: Array<{ cmd: string; args: string[] }>
} = {
  whichStatus: 0,
  lastSpawn: null,
  spawnArgs: [],
}

class FakeChildProcess extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  killed = false
  kill(_signal?: string) {
    this.killed = true
    this.emit("exit", 0)
    return true
  }
  unref() {
    /* noop */
  }
}

vi.mock("node:child_process", () => ({
  spawnSync: (cmd: string) => {
    if (cmd === "which") {
      return { status: state.whichStatus, stdout: Buffer.from(""), stderr: Buffer.from("") }
    }
    return { status: 0, stdout: Buffer.from(""), stderr: Buffer.from("") }
  },
  spawn: (cmd: string, args: string[]) => {
    state.spawnArgs.push({ cmd, args })
    const proc = new FakeChildProcess()
    state.lastSpawn = proc
    return proc
  },
}))

// Import AFTER mock is registered
import { spawnNgrok } from "../../tunnel/ngrok"
import type { TunnelLogger } from "../../tunnel/types"

function makeLogger(): TunnelLogger {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    dim: vi.fn<(msg: string) => void>(),
  }
}

beforeEach(() => {
  state.whichStatus = 0
  state.lastSpawn = null
  state.spawnArgs = []
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("spawnNgrok — happy path", () => {
  it('emits ngrok URL when stdout contains {"url":"https://..."}', async () => {
    const logger = makeLogger()
    const handle = spawnNgrok({ port: "9741", logger })

    expect(state.spawnArgs[0]?.cmd).toBe("ngrok")
    expect(state.spawnArgs[0]?.args).toEqual(["http", "9741", "--log", "stdout", "--log-format", "json"])

    const proc = state.lastSpawn
    expect(proc).not.toBeNull()
    proc?.stdout.emit("data", Buffer.from(`${JSON.stringify({ url: "https://abcd.ngrok-free.app", lvl: "info" })}\n`))

    const url = await handle.ready
    expect(url).toBe("https://abcd.ngrok-free.app")
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("https://abcd.ngrok-free.app"))
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("/api/webhook"))
  })

  it("ignores non-JSON lines and resolves on the first https URL", async () => {
    const logger = makeLogger()
    const handle = spawnNgrok({ port: "3000", logger })
    const proc = state.lastSpawn
    proc?.stdout.emit("data", Buffer.from("starting up...\nnot json\n"))
    proc?.stdout.emit("data", Buffer.from(`${JSON.stringify({ url: "https://example.ngrok.io" })}\n`))

    await expect(handle.ready).resolves.toBe("https://example.ngrok.io")
  })

  it("kill() signals the process group (SIGTERM)", () => {
    const logger = makeLogger()
    const handle = spawnNgrok({ port: "9741", logger })
    const proc = state.lastSpawn
    expect(proc).not.toBeNull()

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true)
    handle.kill()
    expect(killSpy).toHaveBeenCalledWith(-4242, "SIGTERM")
    killSpy.mockRestore()
  })
})

describe("spawnNgrok — graceful degrade", () => {
  it("returns a null-handle with an actionable warning when ngrok is not on PATH", async () => {
    state.whichStatus = 1
    const logger = makeLogger()
    const handle = spawnNgrok({ port: "9741", logger })

    expect(handle.child).toBeNull()
    expect(await handle.ready).toBeNull()
    expect(() => handle.kill()).not.toThrow()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("ngrok not found"))
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("brew install ngrok"))
    // Must mention fallback to cloudflare so agents can self-correct.
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("cloudflare"))
  })

  it("ready resolves to null when the process exits before emitting a URL", async () => {
    const logger = makeLogger()
    const handle = spawnNgrok({ port: "9741", logger })
    const proc = state.lastSpawn
    proc?.emit("exit", 1)
    await expect(handle.ready).resolves.toBeNull()
  })
})
