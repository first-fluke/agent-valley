/**
 * Ledger Replay — derives TeamState from an ordered list of LedgerEvents.
 * Pure function, no I/O, no external dependencies.
 *
 * Rules:
 * - node.leave → implicit agent.cancelled for all active issues on that node
 * - agent.done/failed require a prior agent.start for that issueKey on that node
 * - Duplicate agent.start for the same issueKey on the same node is idempotent
 */

import type { LedgerEvent, NodePresence, TeamState } from "../domain/ledger"

export function replayLedger(events: LedgerEvent[]): TeamState {
  const nodes = new Map<string, NodePresence>()
  let lastSeq = 0

  for (const event of events) {
    if (event.seq > lastSeq) lastSeq = event.seq

    switch (event.type) {
      case "node.join": {
        nodes.set(event.nodeId, {
          nodeId: event.nodeId,
          displayName: event.payload.displayName,
          defaultAgentType: event.payload.defaultAgentType,
          maxParallel: event.payload.maxParallel,
          online: true,
          joinedAt: event.relayTimestamp,
          activeIssues: [],
        })
        break
      }

      case "node.reconnect": {
        const node = nodes.get(event.nodeId)
        if (node) {
          node.online = true
        }
        break
      }

      case "node.leave": {
        const node = nodes.get(event.nodeId)
        if (node) {
          node.online = false
          node.activeIssues = []
        }
        break
      }

      case "agent.start": {
        const node = nodes.get(event.nodeId)
        if (!node) break
        const existing = node.activeIssues.find((i) => i.issueKey === event.payload.issueKey)
        if (!existing) {
          node.activeIssues.push({
            issueKey: event.payload.issueKey,
            issueId: event.payload.issueId,
            agentType: event.payload.agentType,
            startedAt: event.relayTimestamp,
          })
        }
        break
      }

      case "agent.done":
      case "agent.failed":
      case "agent.cancelled": {
        const node = nodes.get(event.nodeId)
        if (!node) break
        node.activeIssues = node.activeIssues.filter((i) => i.issueKey !== event.payload.issueKey)
        break
      }
    }
  }

  return { nodes, lastSeq }
}
