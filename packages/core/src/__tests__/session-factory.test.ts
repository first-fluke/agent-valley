/**
 * SessionFactory tests — registry, creation, error messages.
 */
import { beforeEach, describe, expect, test } from "vitest"
import type { AgentSession } from "../sessions/agent-session.ts"
import { SessionRegistry } from "../sessions/session-factory.ts"

/** Minimal mock session for testing the registry. */
function mockSession(): AgentSession {
  return {
    start: async () => {},
    execute: async () => {},
    cancel: async () => {},
    kill: async () => {},
    isAlive: () => false,
    on: () => {},
    off: () => {},
    dispose: async () => {},
  }
}

describe("SessionRegistry", () => {
  let registry: SessionRegistry

  beforeEach(() => {
    registry = new SessionRegistry()
  })

  test("register + create roundtrip", () => {
    registry.register("test-agent", () => mockSession())
    const session = registry.create("test-agent")
    expect(session).toBeDefined()
    expect(session.isAlive()).toBe(false)
  })

  test("create for unknown type throws with available types listed", () => {
    registry.register("claude", () => mockSession())
    registry.register("codex", () => mockSession())

    expect(() => registry.create("unknown")).toThrow('Unknown agent type: "unknown"')
    expect(() => registry.create("unknown")).toThrow("Available: claude, codex")
    expect(() => registry.create("unknown")).toThrow("registerSession")
  })

  test("create with no registered types shows (none)", () => {
    expect(() => registry.create("anything")).toThrow("Available: (none)")
  })

  test("list() returns registered types", () => {
    registry.register("alpha", () => mockSession())
    registry.register("beta", () => mockSession())
    expect(registry.list()).toEqual(["alpha", "beta"])
  })

  test("list() returns empty array when nothing registered", () => {
    expect(registry.list()).toEqual([])
  })

  test("register overwrites existing registration", () => {
    let callCount = 0
    registry.register("agent", () => {
      callCount = 1
      return mockSession()
    })
    registry.register("agent", () => {
      callCount = 2
      return mockSession()
    })

    registry.create("agent")
    expect(callCount).toBe(2)
  })

  test("registerBuiltins registers claude, codex, gemini", async () => {
    await registry.registerBuiltins()
    const types = registry.list()
    expect(types).toContain("claude")
    expect(types).toContain("codex")
    expect(types).toContain("gemini")
  })
})
