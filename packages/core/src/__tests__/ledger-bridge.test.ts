/**
 * LedgerBridge / relay wiring tests.
 *
 * Covers:
 *   - LedgerBridge forwards orchestrator events to the publisher with the
 *     correct event type + nodeId envelope.
 *   - A rejected publisher.publish() is swallowed (WARN log), never
 *     thrown back into the orchestrator's event emission path.
 *   - dispose() detaches all listeners and disposes the publisher.
 *   - decideLedgerRelay(): single-node (team mode off) vs missing-session
 *     vs ready gating decisions.
 *   - wireLedgerRelay(): constructs + attaches a LedgerBridge only when
 *     team mode + a valid session are both present; never throws.
 *   - loadRelayCredentials(): missing / corrupt / incomplete / expired
 *     credential file all resolve to null instead of throwing.
 */

import { mkdir, unlink, writeFile } from "node:fs/promises"
import { afterEach, describe, expect, test, vi } from "vitest"
import type { Config } from "../config/yaml-loader"
import type { LedgerEvent, LedgerEventPublisher } from "../domain/ledger"
import { OrchestratorEventEmitter } from "../orchestrator/event-emitter"
import type { Orchestrator } from "../orchestrator/orchestrator"
import { loadRelayCredentials } from "../relay/credentials"
import { LedgerBridge } from "../relay/ledger-bridge"
import { decideLedgerRelay, wireLedgerRelay } from "../relay/ledger-wiring"

function makeFakePublisher(): LedgerEventPublisher & {
  published: Array<Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">>
  disposed: boolean
} {
  const published: Array<Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">> = []
  return {
    published,
    disposed: false,
    async publish(event) {
      published.push(event)
    },
    async dispose() {
      this.disposed = true
    },
  }
}

/** LedgerBridge only calls .on()/.off() on the injected orchestrator at runtime; the plain event emitter satisfies that at the type level via a cast. */
function makeFakeOrchestrator(): Orchestrator {
  return new OrchestratorEventEmitter() as unknown as Orchestrator
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    trackerKind: "linear",
    linearApiKey: "key",
    linearTeamId: "team",
    linearTeamUuid: "uuid",
    linearWebhookSecret: "secret",
    workflowStates: { todo: "todo", inProgress: "in_progress", done: "done", cancelled: "cancelled" },
    workspaceRoot: "/tmp/ws",
    agentType: "claude",
    agentTimeout: 3600,
    agentMaxRetries: 3,
    agentRetryDelay: 60,
    maxParallel: 1,
    serverPort: 9741,
    logLevel: "info",
    logFormat: "json",
    deliveryMode: "merge",
    promptTemplate: "prompt",
    routingRules: [],
    observability: {
      otel: { enabled: false, endpoint: "", serviceName: "x" },
      prometheus: { enabled: false, path: "/metrics" },
    },
    ...overrides,
  } as Config
}

describe("LedgerBridge", () => {
  test("forwards agent.start to the publisher with type + nodeId envelope", async () => {
    const orchestrator = makeFakeOrchestrator()
    const publisher = makeFakePublisher()
    const bridge = new LedgerBridge(orchestrator, publisher, "alice:machine")

    orchestrator.publish("agent.start", { agentType: "claude", issueKey: "PROJ-1", issueId: "i1" })
    // publish() is fire-and-forget internally but the mock publisher's
    // publish() is synchronous-resolving; a microtask flush is enough.
    await Promise.resolve()

    expect(publisher.published).toHaveLength(1)
    expect(publisher.published[0]).toMatchObject({
      type: "agent.start",
      nodeId: "alice:machine",
      payload: { agentType: "claude", issueKey: "PROJ-1", issueId: "i1" },
    })

    await bridge.dispose()
  })

  test("a publisher.publish() rejection is swallowed and never thrown back into the emitter", async () => {
    const orchestrator = makeFakeOrchestrator()
    const publisher = makeFakePublisher()
    publisher.publish = vi.fn(async () => {
      throw new Error("network down")
    })
    const bridge = new LedgerBridge(orchestrator, publisher, "alice:machine")

    // Must not throw synchronously nor produce an unhandled rejection.
    expect(() =>
      orchestrator.publish("agent.done", { issueKey: "PROJ-1", issueId: "i1", durationMs: 10 }),
    ).not.toThrow()
    await new Promise((r) => setTimeout(r, 10))

    await bridge.dispose()
  })

  test("dispose() detaches listeners so further events are not published", async () => {
    const orchestrator = makeFakeOrchestrator()
    const publisher = makeFakePublisher()
    const bridge = new LedgerBridge(orchestrator, publisher, "alice:machine")

    await bridge.dispose()
    expect(publisher.disposed).toBe(true)

    orchestrator.publish("agent.start", { agentType: "claude", issueKey: "PROJ-2", issueId: "i2" })
    await Promise.resolve()

    expect(publisher.published).toHaveLength(0)
  })
})

describe("decideLedgerRelay — gating decision", () => {
  test("single-node: team fields absent -> disabled", () => {
    const config = makeConfig()
    expect(decideLedgerRelay(config, { accessToken: "t", userId: "u", expiresAt: 0 })).toEqual({
      enabled: false,
      reason: "single_node",
    })
  })

  test("team mode configured but no session -> disabled with missing_session reason", () => {
    const config = makeConfig({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", teamId: "team-1" })
    expect(decideLedgerRelay(config, null)).toEqual({ enabled: false, reason: "missing_session" })
  })

  test("team mode configured + valid session -> enabled", () => {
    const config = makeConfig({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", teamId: "team-1" })
    expect(decideLedgerRelay(config, { accessToken: "t", userId: "u", expiresAt: 0 })).toEqual({
      enabled: true,
      reason: "ready",
    })
  })
})

describe("wireLedgerRelay — factory", () => {
  test("single-node config returns null without calling the credentials loader's side effects", () => {
    const orchestrator = makeFakeOrchestrator()
    const config = makeConfig()
    const loader = vi.fn(() => null)
    const bridge = wireLedgerRelay(orchestrator, config, loader)
    expect(bridge).toBeNull()
  })

  test("team mode without a session returns null (no crash)", () => {
    const orchestrator = makeFakeOrchestrator()
    const config = makeConfig({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", teamId: "team-1" })
    const bridge = wireLedgerRelay(orchestrator, config, () => null)
    expect(bridge).toBeNull()
  })

  test("team mode with a valid session constructs and attaches a LedgerBridge", async () => {
    const orchestrator = makeFakeOrchestrator()
    const config = makeConfig({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", teamId: "team-1" })
    const bridge = wireLedgerRelay(orchestrator, config, () => ({ accessToken: "tok", userId: "u1", expiresAt: 0 }))
    expect(bridge).not.toBeNull()
    await bridge?.dispose()
  })

  test("a throwing credentials loader is caught — relay disabled, never crashes bootstrap", () => {
    const orchestrator = makeFakeOrchestrator()
    const config = makeConfig({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon", teamId: "team-1" })
    const bridge = wireLedgerRelay(orchestrator, config, () => {
      throw new Error("disk read failed")
    })
    expect(bridge).toBeNull()
  })
})

describe("loadRelayCredentials", () => {
  const TEST_PATH = `/tmp/relay-credentials-test-${crypto.randomUUID()}.json`

  afterEach(async () => {
    try {
      await unlink(TEST_PATH)
    } catch {
      /* already removed */
    }
  })

  test("missing file resolves to null", () => {
    expect(loadRelayCredentials(TEST_PATH)).toBeNull()
  })

  test("corrupt JSON resolves to null", async () => {
    await mkdir(TEST_PATH.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(TEST_PATH, "{ not valid json", "utf-8")
    expect(loadRelayCredentials(TEST_PATH)).toBeNull()
  })

  test("missing accessToken/userId resolves to null", async () => {
    await mkdir(TEST_PATH.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(TEST_PATH, JSON.stringify({ email: "a@b.com" }), "utf-8")
    expect(loadRelayCredentials(TEST_PATH)).toBeNull()
  })

  test("expired session resolves to null", async () => {
    await mkdir(TEST_PATH.replace(/\/[^/]+$/, ""), { recursive: true })
    await writeFile(
      TEST_PATH,
      JSON.stringify({ accessToken: "tok", userId: "u1", expiresAt: Date.now() - 1_000 }),
      "utf-8",
    )
    expect(loadRelayCredentials(TEST_PATH)).toBeNull()
  })

  test("valid, unexpired credentials are returned", async () => {
    await mkdir(TEST_PATH.replace(/\/[^/]+$/, ""), { recursive: true })
    const expiresAt = Date.now() + 60_000
    await writeFile(TEST_PATH, JSON.stringify({ accessToken: "tok", userId: "u1", expiresAt }), "utf-8")
    expect(loadRelayCredentials(TEST_PATH)).toEqual({ accessToken: "tok", userId: "u1", expiresAt })
  })
})
