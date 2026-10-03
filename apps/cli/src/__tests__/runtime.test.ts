import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parsePidState, resolveRuntimePaths, resolveServerPort, waitForDashboard } from "../runtime"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "av-runtime-"))
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "config"))
  vi.stubEnv("SERVER_PORT", undefined)
  vi.stubEnv("SYMPHONY_DASHBOARD_HOST", undefined)
  vi.stubEnv("SYMPHONY_DASHBOARD_TOKEN", undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { force: true, recursive: true })
})

describe("CLI runtime paths", () => {
  it("uses the TypeScript supervisor in an unbuilt source checkout", () => {
    const cliDir = join(root, "apps/cli/src")
    mkdirSync(cliDir, { recursive: true })
    mkdirSync(join(root, "apps/dashboard"), { recursive: true })
    writeFileSync(join(root, "apps/dashboard/package.json"), "{}")
    writeFileSync(join(cliDir, "supervisor.ts"), "")
    expect(resolveRuntimePaths(root, cliDir).supervisorScript).toBe(join(cliDir, "supervisor.ts"))
    writeFileSync(join(cliDir, "supervisor.js"), "")
    expect(resolveRuntimePaths(root, cliDir).supervisorScript).toBe(join(cliDir, "supervisor.js"))
  })

  it("explains the missing dashboard in a standalone CLI installation", () => {
    expect(() => resolveRuntimePaths(root, root)).toThrow("standalone CLI does not include the dashboard")
  })

  it("reports a missing supervisor before spawning", () => {
    mkdirSync(join(root, "apps/dashboard"), { recursive: true })
    writeFileSync(join(root, "apps/dashboard/package.json"), "{}")
    expect(() => resolveRuntimePaths(root, root)).toThrow("Supervisor is missing")
  })
})

describe("operator ports and PID state", () => {
  it("resolves environment > running daemon > project > global > default", () => {
    expect(resolveServerPort(root)).toBe("9741")
    mkdirSync(join(root, "config/agent-valley"), { recursive: true })
    writeFileSync(join(root, "config/agent-valley/settings.yaml"), "server:\n  port: 9800\n")
    expect(resolveServerPort(root)).toBe("9800")
    writeFileSync(join(root, "av.yaml"), "server:\n  port: 9900\n")
    expect(resolveServerPort(root)).toBe("9900")
    expect(resolveServerPort(root, 9901)).toBe("9901")
    vi.stubEnv("SERVER_PORT", "9902")
    expect(resolveServerPort(root, 9901)).toBe("9902")
  })

  it.each(["0", "65536", "12.5", "abc", ""])("rejects invalid SERVER_PORT %s", (port) => {
    vi.stubEnv("SERVER_PORT", port)
    expect(() => resolveServerPort(root)).toThrow("SERVER_PORT or server.port")
  })

  it("accepts legacy PID files and rejects dangerous process-group PIDs", () => {
    const state = { dashboard: 420, ngrok: 421, port: 9741, startedAt: "2026-01-01" }
    expect(parsePidState(JSON.stringify(state))).toEqual(state)
    for (const pid of [0, 1, -1, 1.5, "420"]) {
      expect(parsePidState(JSON.stringify({ ...state, dashboard: pid }))).toBeNull()
      expect(parsePidState(JSON.stringify({ ...state, ngrok: pid }))).toBeNull()
    }
    expect(parsePidState("not-json")).toBeNull()
    expect(parsePidState("null")).toBeNull()
  })
})

describe("dashboard readiness", () => {
  it("waits through unavailable and degraded responses until the orchestrator is running", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(Response.json({ status: "degraded" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ status: "ok", isRunning: true }))
    await waitForDashboard("9980", { isAlive: () => true, fetch: fetcher, pollMs: 1, timeoutMs: 100 })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:9980/api/health")
  })

  it("fails immediately when the spawned supervisor exits", async () => {
    await expect(waitForDashboard("9980", { isAlive: () => false })).rejects.toThrow("process exited")
  })

  it("does not report a stopped orchestrator as ready", async () => {
    await expect(
      waitForDashboard("9980", {
        isAlive: () => true,
        fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "ok", isRunning: false })),
        timeoutMs: 10,
        pollMs: 1,
      }),
    ).rejects.toThrow("did not become ready")
  })

  it("uses the configured IPv6 host and dashboard token", async () => {
    vi.stubEnv("SYMPHONY_DASHBOARD_HOST", "::")
    vi.stubEnv("SYMPHONY_DASHBOARD_TOKEN", "local-session")
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: "ok", isRunning: true }))
    await waitForDashboard("9980", { isAlive: () => true, fetch: fetcher })
    expect(fetcher).toHaveBeenCalledWith(
      "http://[::1]:9980/api/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-session" },
      }),
    )
  })
})
