import { describe, expect, test } from "vitest"
import type { LedgerEvent } from "../domain/ledger"
import { replayLedger } from "./replay"

function makeEvent(partial: Partial<LedgerEvent> & Pick<LedgerEvent, "type" | "payload">): LedgerEvent {
  return {
    v: 1,
    seq: 1,
    relayTimestamp: "2026-03-21T10:00:00Z",
    clientTimestamp: "2026-03-21T10:00:00Z",
    nodeId: "gahyun:macbook",
    ...partial,
  } as LedgerEvent
}

describe("replayLedger", () => {
  test("empty events returns empty state", () => {
    const state = replayLedger([])
    expect(state.nodes.size).toBe(0)
    expect(state.lastSeq).toBe(0)
  })

  test("node.join creates a node", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
    ]
    const state = replayLedger(events)
    expect(state.nodes.size).toBe(1)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.displayName).toBe("가현")
    expect(node.online).toBe(true)
    expect(node.activeIssues).toEqual([])
  })

  test("agent.start adds active issue", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.activeIssues).toHaveLength(1)
    expect(node.activeIssues[0].issueKey).toBe("FIR-12")
  })

  test("agent.done removes active issue", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
      makeEvent({ seq: 3, type: "agent.done", payload: { issueKey: "FIR-12", issueId: "id-12", durationMs: 5000 } }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.activeIssues).toHaveLength(0)
  })

  test("node.leave clears all active issues", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
      makeEvent({
        seq: 3,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-15", issueId: "id-15" },
      }),
      makeEvent({ seq: 4, type: "node.leave", payload: { reason: "crash" } }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.online).toBe(false)
    expect(node.activeIssues).toHaveLength(0)
  })

  test("duplicate agent.start is idempotent", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
      makeEvent({
        seq: 3,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.activeIssues).toHaveLength(1)
  })

  test("agent.done without prior start is harmless", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({ seq: 2, type: "agent.done", payload: { issueKey: "FIR-99", issueId: "id-99", durationMs: 1000 } }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.activeIssues).toHaveLength(0)
  })

  test("multiple nodes", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        nodeId: "gahyun:macbook",
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        nodeId: "eungwang:desktop",
        type: "node.join",
        payload: { defaultAgentType: "gemini", maxParallel: 2, displayName: "은광" },
      }),
      makeEvent({
        seq: 3,
        nodeId: "gahyun:macbook",
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
      makeEvent({
        seq: 4,
        nodeId: "eungwang:desktop",
        type: "agent.start",
        payload: { agentType: "gemini", issueKey: "FIR-18", issueId: "id-18" },
      }),
    ]
    const state = replayLedger(events)
    expect(state.nodes.size).toBe(2)
    expect(state.nodes.get("gahyun:macbook")?.activeIssues).toHaveLength(1)
    expect(state.nodes.get("eungwang:desktop")?.activeIssues).toHaveLength(1)
    expect(state.lastSeq).toBe(4)
  })

  test("node.reconnect sets online back to true", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({ seq: 2, type: "node.leave", payload: { reason: "timeout" } }),
      makeEvent({ seq: 3, type: "node.reconnect", payload: { lastSeq: 2 } }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.online).toBe(true)
  })

  test("tracks lastSeq correctly with gaps", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 10,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({ seq: 42, type: "agent.start", payload: { agentType: "claude", issueKey: "FIR-1", issueId: "id-1" } }),
    ]
    const state = replayLedger(events)
    expect(state.lastSeq).toBe(42)
  })

  test("agent.failed removes active issue", () => {
    const events: LedgerEvent[] = [
      makeEvent({
        seq: 1,
        type: "node.join",
        payload: { defaultAgentType: "claude", maxParallel: 3, displayName: "가현" },
      }),
      makeEvent({
        seq: 2,
        type: "agent.start",
        payload: { agentType: "claude", issueKey: "FIR-12", issueId: "id-12" },
      }),
      makeEvent({
        seq: 3,
        type: "agent.failed",
        payload: {
          issueKey: "FIR-12",
          issueId: "id-12",
          error: { code: "TIMEOUT", message: "timed out", retryable: true },
        },
      }),
    ]
    const state = replayLedger(events)
    const node = state.nodes.get("gahyun:macbook")
    expect(node).toBeDefined()
    expect(node.activeIssues).toHaveLength(0)
  })
})
