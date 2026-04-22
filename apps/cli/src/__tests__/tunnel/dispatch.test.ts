/**
 * Tests for the tunnel dispatcher:
 *   - provider === "none" produces a no-op handle (child=null, ready→null)
 *   - unknown provider surfaces an actionable error
 *
 * The cloudflare + ngrok branches are covered by their own suites — here
 * we only exercise the switch itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { spawnTunnel } from "../../tunnel"
import type { TunnelLogger } from "../../tunnel/types"

function makeLogger(): TunnelLogger {
  return {
    info: vi.fn<(msg: string) => void>(),
    warn: vi.fn<(msg: string) => void>(),
    dim: vi.fn<(msg: string) => void>(),
  }
}

describe("spawnTunnel", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("provider=none returns a null handle and never spawns a child", async () => {
    const logger = makeLogger()
    const handle = spawnTunnel({ provider: "none", cloudflare: { mode: "quick" } }, { port: "9741", logger })
    expect(handle.child).toBeNull()
    expect(await handle.ready).toBeNull()
    // kill must be a no-op / not throw
    expect(() => handle.kill()).not.toThrow()
    expect(logger.dim).toHaveBeenCalledWith(expect.stringContaining("tunnel.provider=none"))
  })

  it("unknown provider throws with an actionable fix message", () => {
    const logger = makeLogger()
    expect(() =>
      spawnTunnel(
        // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid to exercise the guard
        { provider: "nope" as any, cloudflare: { mode: "quick" } },
        { port: "9741", logger },
      ),
    ).toThrow(/Unknown tunnel.provider/)
  })
})
