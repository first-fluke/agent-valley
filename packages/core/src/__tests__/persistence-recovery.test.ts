/**
 * decideRecovery unit tests — pure decision engine, injected probe (no real PID checks).
 */

import { describe, expect, test } from "vitest"
import { decideRecovery } from "../orchestrator/persistence/recovery"
import type {
  PersistedAttempt,
  PersistedRetryEntry,
  RunStateSnapshot,
} from "../orchestrator/persistence/run-state-store"

function makeAttempt(overrides: Partial<PersistedAttempt> = {}): PersistedAttempt {
  return {
    issueId: "issue-1",
    attemptId: "attempt-1",
    workspacePath: "/ws/issue-1",
    pid: null,
    startedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  }
}

function makeRetryEntry(overrides: Partial<PersistedRetryEntry> = {}): PersistedRetryEntry {
  return {
    issueId: "issue-2",
    attemptCount: 1,
    nextRetryAt: "2026-07-16T00:05:00.000Z",
    lastError: "boom",
    ...overrides,
  }
}

function makeSnapshot(overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
  return { version: 1, updatedAt: "", activeAttempts: [], retryQueue: [], ...overrides }
}

describe("decideRecovery", () => {
  test("reattaches an attempt whose pid probe reports alive", () => {
    const attempt = makeAttempt({ pid: 111 })
    const decision = decideRecovery(makeSnapshot({ activeAttempts: [attempt] }), () => true)
    expect(decision.reattach).toEqual([attempt])
    expect(decision.reap).toEqual([])
  })

  test("reaps an attempt whose pid probe reports dead", () => {
    const attempt = makeAttempt({ pid: 222 })
    const decision = decideRecovery(makeSnapshot({ activeAttempts: [attempt] }), () => false)
    expect(decision.reattach).toEqual([])
    expect(decision.reap).toEqual([attempt])
  })

  test("reaps an attempt with no pid on record (liveness unverifiable) without calling the probe", () => {
    const attempt = makeAttempt({ pid: null })
    let probeCalled = false
    const decision = decideRecovery(makeSnapshot({ activeAttempts: [attempt] }), () => {
      probeCalled = true
      return true
    })
    expect(decision.reap).toEqual([attempt])
    expect(decision.reattach).toEqual([])
    expect(probeCalled).toBe(false)
  })

  test("passes retry queue entries through unchanged", () => {
    const entry = makeRetryEntry()
    const decision = decideRecovery(makeSnapshot({ retryQueue: [entry] }))
    expect(decision.restoredRetries).toEqual([entry])
  })

  test("classifies multiple attempts independently", () => {
    const alive = makeAttempt({ issueId: "a", pid: 1 })
    const dead = makeAttempt({ issueId: "b", pid: 2 })
    const noPid = makeAttempt({ issueId: "c", pid: null })
    const decision = decideRecovery(makeSnapshot({ activeAttempts: [alive, dead, noPid] }), (pid) => pid === 1)
    expect(decision.reattach.map((a) => a.issueId)).toEqual(["a"])
    expect(decision.reap.map((a) => a.issueId).sort()).toEqual(["b", "c"])
  })
})
