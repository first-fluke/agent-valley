import { describe, test, expect, beforeEach } from "bun:test"
import { setOrchestrator, getOrchestrator } from "../lib/orchestrator-singleton"

describe("Orchestrator Singleton", () => {
  beforeEach(() => {
    // Reset global state
    globalThis.__composer_orchestrator__ = undefined
  })

  test("returns null when not initialized", () => {
    expect(getOrchestrator()).toBeNull()
  })

  test("returns the instance after set", () => {
    const mock = {
      getStatus: () => ({ isRunning: true }),
      handleWebhook: async () => ({ status: 200, body: '{"ok":true}' }),
    }
    setOrchestrator(mock)
    expect(getOrchestrator()).toBe(mock)
  })

  test("overwrites previous instance", () => {
    const first = {
      getStatus: () => ({ first: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
    }
    const second = {
      getStatus: () => ({ second: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
    }
    setOrchestrator(first)
    setOrchestrator(second)
    expect(getOrchestrator()).toBe(second)
  })

  test("shares state via globalThis across modules", () => {
    const mock = {
      getStatus: () => ({ shared: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
    }
    setOrchestrator(mock)
    // Verify via globalThis directly
    expect(globalThis.__composer_orchestrator__).toBe(mock)
  })
})
