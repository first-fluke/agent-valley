import { beforeEach, describe, expect, test, vi } from "vitest"
import {
  getOrchestrator,
  initializeOrchestrator,
  type OrchestratorInstance,
  setOrchestrator,
} from "../lib/orchestrator-singleton"

describe("Orchestrator Singleton", () => {
  beforeEach(() => {
    // Reset global state
    globalThis.__agent_valley_orchestrator__ = undefined
    globalThis.__agent_valley_initialization__ = undefined
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
      stop: async () => {
        stopCalled = true
      },
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

  function fakeInstance(stop = async () => {}): OrchestratorInstance {
    return {
      getStatus: () => ({}),
      handleWebhook: async () => ({ status: 200, body: "" }),
      stop,
      on: () => {},
      off: () => {},
    }
  }

  test("hot reload stops the previous runtime before starting the next", async () => {
    const calls: string[] = []
    await setOrchestrator(
      fakeInstance(async () => {
        calls.push("stop previous")
      }),
    )
    const next = fakeInstance()
    await initializeOrchestrator(async () => {
      expect(getOrchestrator()).toBeNull()
      calls.push("start next")
      return next
    })
    expect(calls).toEqual(["stop previous", "start next"])
    expect(getOrchestrator()).toBe(next)
  })

  test("concurrent initialization starts only one scheduler", async () => {
    let complete!: (instance: OrchestratorInstance) => void
    const pending = new Promise<OrchestratorInstance>((resolve) => {
      complete = resolve
    })
    const create = vi.fn(() => pending)
    const first = initializeOrchestrator(create)
    const second = initializeOrchestrator(create)
    expect(second).toBe(first)
    complete(fakeInstance())
    await Promise.all([first, second])
    expect(create).toHaveBeenCalledOnce()
  })

  test("a failed restart exposes no stopped singleton and can be retried", async () => {
    await setOrchestrator(fakeInstance())
    await expect(
      initializeOrchestrator(async () => {
        throw new Error("Missing settings")
      }),
    ).rejects.toThrow("Missing settings")
    expect(getOrchestrator()).toBeNull()
    const next = fakeInstance()
    await initializeOrchestrator(async () => next)
    expect(getOrchestrator()).toBe(next)
  })
})
