"use client"

import { useEffect, useRef, useState } from "react"
import type { TeamState, TeamNode, ActiveIssue, ConnectionStatus } from "../types/team"

interface LedgerRow {
  seq: number
  team_id: string
  node_id: string
  user_id: string
  type: string
  payload: Record<string, unknown>
  client_timestamp: string
  created_at: string
}

function rowToTeamStateUpdate(nodes: Map<string, TeamNode>, row: LedgerRow): void {
  switch (row.type) {
    case "node.join": {
      const payload = row.payload as { defaultAgentType: string; maxParallel: number; displayName: string }
      nodes.set(row.node_id, {
        nodeId: row.node_id,
        displayName: payload.displayName ?? row.node_id,
        defaultAgentType: (payload.defaultAgentType ?? "claude") as TeamNode["defaultAgentType"],
        maxParallel: payload.maxParallel ?? 3,
        online: true,
        joinedAt: row.created_at,
        activeIssues: [],
      })
      break
    }
    case "node.reconnect": {
      const node = nodes.get(row.node_id)
      if (node) node.online = true
      break
    }
    case "node.leave": {
      const node = nodes.get(row.node_id)
      if (node) {
        node.online = false
        node.activeIssues = []
      }
      break
    }
    case "agent.start": {
      const node = nodes.get(row.node_id)
      if (!node) break
      const p = row.payload as { agentType: string; issueKey: string; issueId: string }
      const exists = node.activeIssues.find((i) => i.issueKey === p.issueKey)
      if (!exists) {
        node.activeIssues.push({
          issueKey: p.issueKey,
          issueId: p.issueId,
          agentType: (p.agentType ?? "claude") as ActiveIssue["agentType"],
          startedAt: row.created_at,
        })
      }
      break
    }
    case "agent.done":
    case "agent.failed":
    case "agent.cancelled": {
      const node = nodes.get(row.node_id)
      if (!node) break
      const p = row.payload as { issueKey: string }
      node.activeIssues = node.activeIssues.filter((i) => i.issueKey !== p.issueKey)
      break
    }
  }
}

function buildTeamState(rows: LedgerRow[]): { nodes: Map<string, TeamNode>; lastSeq: number } {
  const nodes = new Map<string, TeamNode>()
  let lastSeq = 0
  for (const row of rows) {
    if (row.seq > lastSeq) lastSeq = row.seq
    rowToTeamStateUpdate(nodes, row)
  }
  return { nodes, lastSeq }
}

function mapToArray(nodes: Map<string, TeamNode>): TeamNode[] {
  return Array.from(nodes.values())
}

interface UseTeamLedgerOptions {
  supabaseUrl: string
  supabaseAnonKey: string
  teamId: string
}

export function useTeamLedger(options: UseTeamLedgerOptions | null) {
  const [teamState, setTeamState] = useState<TeamState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const nodesRef = useRef<Map<string, TeamNode>>(new Map())
  const lastSeqRef = useRef(0)
  const bufferRef = useRef<LedgerRow[]>([])

  useEffect(() => {
    if (!options) {
      setStatus("disconnected")
      return
    }

    let active = true
    let eventSource: EventSource | null = null

    const { supabaseUrl, supabaseAnonKey, teamId } = options

    // Subscribe-first pattern: start listening before fetching
    const realtimeUrl = `${supabaseUrl}/realtime/v1/channel/public:ledger_events:team_id=eq.${teamId}`

    // Step 1: Fetch full ledger
    const fetchAndSync = async () => {
      try {
        const res = await fetch(
          `${supabaseUrl}/rest/v1/ledger_events?team_id=eq.${teamId}&order=seq.asc`,
          {
            headers: {
              apikey: supabaseAnonKey,
              Authorization: `Bearer ${supabaseAnonKey}`,
            },
          },
        )

        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)

        const rows = (await res.json()) as LedgerRow[]
        if (!active) return

        const { nodes, lastSeq } = buildTeamState(rows)

        // Apply buffered events that arrived during fetch
        const buffered = bufferRef.current.filter((r) => r.seq > lastSeq)
        for (const row of buffered) {
          rowToTeamStateUpdate(nodes, row)
          if (row.seq > lastSeq) lastSeqRef.current = row.seq
        }
        bufferRef.current = []

        nodesRef.current = nodes
        lastSeqRef.current = Math.max(lastSeq, lastSeqRef.current)

        setTeamState({ nodes: mapToArray(nodes), lastSeq: lastSeqRef.current })
        setStatus("connected")
      } catch (err) {
        if (active) setStatus("error")
      }
    }

    // Step 2: Poll for changes (simple polling until Supabase JS SDK is added)
    const pollInterval = setInterval(async () => {
      if (!active) return
      try {
        const res = await fetch(
          `${supabaseUrl}/rest/v1/ledger_events?team_id=eq.${teamId}&seq=gt.${lastSeqRef.current}&order=seq.asc`,
          {
            headers: {
              apikey: supabaseAnonKey,
              Authorization: `Bearer ${supabaseAnonKey}`,
            },
          },
        )
        if (!res.ok) return

        const rows = (await res.json()) as LedgerRow[]
        if (rows.length === 0 || !active) return

        for (const row of rows) {
          rowToTeamStateUpdate(nodesRef.current, row)
          if (row.seq > lastSeqRef.current) lastSeqRef.current = row.seq
        }

        setTeamState({ nodes: mapToArray(nodesRef.current), lastSeq: lastSeqRef.current })
      } catch {
        // silent — will retry next poll
      }
    }, 3000)

    fetchAndSync()

    return () => {
      active = false
      clearInterval(pollInterval)
    }
  }, [options?.supabaseUrl, options?.supabaseAnonKey, options?.teamId])

  return { teamState, status }
}
