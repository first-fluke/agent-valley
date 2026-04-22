/**
 * cloudflared adapter tests.
 *
 * Covered behaviours:
 *   - quick mode spawns `cloudflared tunnel --url …` and extracts the
 *     *.trycloudflare.com URL from the log stream
 *   - named mode spawns `cloudflared tunnel run <name>` and surfaces
 *     the configured hostname (or null when omitted)
 *   - named mode requires `name` — falls back gracefully otherwise
 *   - missing `cloudflared` binary → graceful null-handle + fix hint
 */

import { EventEmitter } from "node:events"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  pid = 7777
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  kill() {
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

import { spawnCloudflare } from "../../tunnel/cloudflare"
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

describe("spawnCloudflare (quick mode)", () => {
  it("spawns cloudflared with --url and --logformat json", () => {
    const logger = makeLogger()
    spawnCloudflare({ mode: "quick" }, { port: "9741", logger })

    expect(state.spawnArgs[0]?.cmd).toBe("cloudflared")
    expect(state.spawnArgs[0]?.args).toEqual([
      "tunnel",
      "--url",
      "http://localhost:9741",
      "--logformat",
      "json",
      "--no-autoupdate",
    ])
  })

  it("extracts the *.trycloudflare.com URL from stdout JSON logs", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "quick" }, { port: "9741", logger })

    const banner = JSON.stringify({
      level: "inf",
      msg: "|  https://random-words-1234.trycloudflare.com                  |",
    })
    state.lastSpawn?.stdout.emit("data", Buffer.from(`${banner}\n`))

    await expect(handle.ready).resolves.toBe("https://random-words-1234.trycloudflare.com")
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("https://random-words-1234.trycloudflare.com"))
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("/api/webhook"))
  })

  it("also picks up URLs emitted on stderr (older cloudflared builds)", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "quick" }, { port: "3000", logger })

    state.lastSpawn?.stderr.emit("data", Buffer.from("INF |  https://abc-xyz.trycloudflare.com  |\n"))

    await expect(handle.ready).resolves.toBe("https://abc-xyz.trycloudflare.com")
  })

  it("ignores non-matching https URLs (e.g. cloudflared dashboard links)", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "quick" }, { port: "3000", logger })
    state.lastSpawn?.stdout.emit("data", Buffer.from("https://dash.cloudflare.com/argo\n"))
    // Process exits before any tryCF URL arrives → ready resolves to null
    state.lastSpawn?.emit("exit", 0)
    await expect(handle.ready).resolves.toBeNull()
  })
})

describe("spawnCloudflare (named mode)", () => {
  it("spawns `cloudflared tunnel run <name>` and resolves with the hostname", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare(
      { mode: "named", name: "av-webhook", hostname: "hooks.example.com" },
      { port: "9741", logger },
    )

    expect(state.spawnArgs[0]?.cmd).toBe("cloudflared")
    expect(state.spawnArgs[0]?.args).toEqual(["tunnel", "run", "av-webhook", "--no-autoupdate"])

    await expect(handle.ready).resolves.toBe("https://hooks.example.com")
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("av-webhook"))
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("hooks.example.com"))
  })

  it("resolves with null when hostname is not configured (named mode, no probe)", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "named", name: "av-webhook" }, { port: "9741", logger })
    await expect(handle.ready).resolves.toBeNull()
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("hostname"))
  })

  it("gracefully degrades when name is missing in named mode (defensive guard)", async () => {
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "named" }, { port: "9741", logger })
    expect(handle.child).toBeNull()
    await expect(handle.ready).resolves.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("name"))
    // Nothing spawned
    expect(state.spawnArgs).toHaveLength(0)
  })
})

describe("spawnCloudflare — graceful degrade when cloudflared is missing", () => {
  it("returns a null-handle and prints install + fallback hints", async () => {
    state.whichStatus = 1
    const logger = makeLogger()
    const handle = spawnCloudflare({ mode: "quick" }, { port: "9741", logger })

    expect(handle.child).toBeNull()
    await expect(handle.ready).resolves.toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cloudflared not found"))
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("brew install cloudflared"))
    // Must mention ngrok fallback so operators can self-correct from the log alone.
    const dimMock = vi.mocked(logger.dim)
    expect(dimMock.mock.calls.some((call) => String(call[0]).includes("ngrok"))).toBe(true)
  })
})
