import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getOrchestrator } from "@/lib/orchestrator-singleton"

const runtime = vi.hoisted(() => ({
  calls: [] as string[],
  failStartup: false,
  disposeRelay: vi.fn(async () => {}),
  shutdownTelemetry: vi.fn(async () => {}),
}))

vi.mock("@/lib/project-root", () => ({ resolveProjectRoot: async () => process.cwd() }))
vi.mock("@/lib/env", () => ({
  toOrchestratorConfig: () => ({
    trackerKind: "linear",
    linearApiKey: "test-key",
    linearTeamId: "TEST",
    linearTeamUuid: "test-team",
    linearWebhookSecret: "test-secret",
    workflowStates: { todo: "todo", inProgress: "working", done: "done", cancelled: "cancelled" },
    workspaceRoot: "/unused-test-workspace",
    logLevel: "error",
    logFormat: "json",
    observability: { prometheus: { enabled: false, path: "/api/metrics" }, otel: { enabled: false } },
  }),
}))
vi.mock("@agent-valley/core/relay/ledger-wiring", () => ({
  wireLedgerRelay: () => ({ dispose: runtime.disposeRelay }),
}))
vi.mock("@agent-valley/core/observability/otel-exporter", () => ({
  createOtelExporter: () => ({ enabled: false, shutdown: runtime.shutdownTelemetry }),
}))
vi.mock("@agent-valley/core/orchestrator/orchestrator", () => ({
  Orchestrator: class {
    constructor() {
      runtime.calls.push("construct")
    }
    async start() {
      runtime.calls.push("start")
      if (runtime.failStartup) throw new Error("Tracker unavailable")
    }
    async stop() {
      runtime.calls.push("stop")
    }
    getHandlers() {
      return { getStatus: () => ({ isRunning: true }), onWebhook: async () => ({ status: 200, body: "" }) }
    }
    on() {}
    off() {}
  },
}))

const { bootstrap } = await import("@/lib/bootstrap")

describe("dashboard bootstrap lifecycle", () => {
  beforeEach(() => {
    globalThis.__agent_valley_orchestrator__ = undefined
    globalThis.__agent_valley_initialization__ = undefined
    runtime.calls.length = 0
    runtime.failStartup = false
    runtime.disposeRelay.mockClear()
    runtime.shutdownTelemetry.mockClear()
    vi.spyOn(process, "chdir").mockImplementation(() => {})
  })

  afterEach(async () => {
    await getOrchestrator()?.stop()
    globalThis.__agent_valley_orchestrator__ = undefined
    globalThis.__agent_valley_metrics__ = undefined
    vi.restoreAllMocks()
  })

  test("reload stops the previous scheduler, relay and telemetry and retains one signal handler", async () => {
    const previousSignals = { term: process.listenerCount("SIGTERM"), int: process.listenerCount("SIGINT") }
    await bootstrap()
    await bootstrap()
    expect(runtime.calls).toEqual(["construct", "start", "stop", "construct", "start"])
    expect(runtime.disposeRelay).toHaveBeenCalledOnce()
    expect(runtime.shutdownTelemetry).toHaveBeenCalledOnce()
    expect(process.listenerCount("SIGTERM")).toBe(previousSignals.term + 1)
    expect(process.listenerCount("SIGINT")).toBe(previousSignals.int + 1)
    await getOrchestrator()?.stop()
    globalThis.__agent_valley_orchestrator__ = undefined
    expect(process.listenerCount("SIGTERM")).toBe(previousSignals.term)
    expect(process.listenerCount("SIGINT")).toBe(previousSignals.int)
  })

  test("failed startup releases partial runtime resources and publishes no singleton", async () => {
    runtime.failStartup = true
    const previousSignals = process.listenerCount("SIGTERM")
    await expect(bootstrap()).rejects.toThrow("Tracker unavailable")
    expect(runtime.calls).toEqual(["construct", "start", "stop"])
    expect(runtime.disposeRelay).toHaveBeenCalledOnce()
    expect(runtime.shutdownTelemetry).toHaveBeenCalledOnce()
    expect(getOrchestrator()).toBeNull()
    expect(process.listenerCount("SIGTERM")).toBe(previousSignals)
  })
})
