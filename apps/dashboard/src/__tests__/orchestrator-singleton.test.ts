import { describe, test, expect, beforeEach } from "vitest"
import { setOrchestrator, getOrchestrator } from "../lib/orchestrator-singleton"

describe("Orchestrator Singleton", () => {
  beforeEach(() => {
    // Reset global state
    globalThis.__agent_valley_orchestrator__ = undefined
  })

  test("returns null when not initialized", () => {
    expect(getOrchestrator()).toBeNull()
  })

  test("returns the instance after set", async () => {
    const mock = {
      getStatus: () => ({ isRunning: true }),
      handleWebhook: async () => ({ status: 200, body: '{"ok":true}' }),
      stop: async () => {},
      on: () => {},
      off: () => {},
    }
    await setOrchestrator(mock)
    expect(getOrchestrator()).toBe(mock)
  })

  test("overwrites previous instance and stops the old one", async () => {
    let stopCalled = false
    const first = {
      getStatus: () => ({ first: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
      stop: async () => { stopCalled = true },
      on: () => {},
      off: () => {},
    }
    const second = {
      getStatus: () => ({ second: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
      stop: async () => {},
      on: () => {},
      off: () => {},
    }
    await setOrchestrator(first)
    await setOrchestrator(second)
    expect(getOrchestrator()).toBe(second)
    expect(stopCalled).toBe(true)
  })

  test("shares state via globalThis across modules", async () => {
    const mock = {
      getStatus: () => ({ shared: true }),
      handleWebhook: async () => ({ status: 200, body: "" }),
      stop: async () => {},
      on: () => {},
      off: () => {},
    }
    await setOrchestrator(mock)
    // Verify via globalThis directly
    expect(globalThis.__agent_valley_orchestrator__).toBe(mock)
  })
})
