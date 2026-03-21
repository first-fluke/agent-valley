"use client"

import { useEffect, useState } from "react"
import type { TeamState, TeamNode, ConnectionStatus } from "../types/team"
import type { OrchestratorState } from "@/features/office/types/agent"

/**
 * Wraps the existing SSE OrchestratorState into TeamState format
 * for standalone mode compatibility.
 */
export function useLocalOrchestrator(sseUrl: string) {
  const [teamState, setTeamState] = useState<TeamState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")

  useEffect(() => {
    let active = true
    const source = new EventSource(sseUrl)

    source.onopen = () => {
      if (active) setStatus("connected")
    }

    source.addEventListener("state", (event) => {
      if (!active) return
      try {
        const state = JSON.parse((event as MessageEvent).data) as OrchestratorState

        const node: TeamNode = {
          nodeId: "local",
          displayName: "Local",
          defaultAgentType: state.config.agentType,
          maxParallel: state.config.maxParallel,
          online: state.isRunning,
          joinedAt: "",
          activeIssues: state.activeWorkspaces.map((ws) => ({
            issueKey: ws.key,
            issueId: ws.issueId,
            agentType: state.config.agentType,
            startedAt: ws.startedAt,
          })),
        }

        setTeamState({ nodes: [node], lastSeq: 0 })
      } catch {
        // skip malformed
      }
    })

    source.onerror = () => {
      if (active) setStatus("error")
    }

    return () => {
      active = false
      source.close()
    }
  }, [sseUrl])

  return { teamState, status }
}
