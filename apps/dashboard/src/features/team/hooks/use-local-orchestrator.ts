"use client"

import { useMemo } from "react"
import type { TeamState, TeamNode, ConnectionStatus } from "../types/team"
import type { OrchestratorState } from "@/features/office/types/agent"

type SSEConnectionStatus = "connecting" | "open" | "closed" | "error"

function mapConnectionStatus(status: SSEConnectionStatus): ConnectionStatus {
  if (status === "open") return "connected"
  if (status === "error") return "error"
  return "connecting"
}

/**
 * Derives TeamState from an already-open SSE OrchestratorState,
 * instead of opening a second EventSource connection.
 */
export function useLocalOrchestrator(
  data: OrchestratorState | null,
  sseStatus: SSEConnectionStatus,
) {
  const teamState = useMemo<TeamState | null>(() => {
    if (!data) return null

    const node: TeamNode = {
      nodeId: "local",
      displayName: "Local",
      defaultAgentType: data.config.agentType,
      maxParallel: data.config.maxParallel,
      online: data.isRunning,
      joinedAt: "",
      activeIssues: data.activeWorkspaces.map((ws) => ({
        issueKey: ws.key,
        issueId: ws.issueId,
        agentType: data.config.agentType,
        startedAt: ws.startedAt,
      })),
    }

    return { nodes: [node], lastSeq: 0 }
  }, [data])

  const status = mapConnectionStatus(sseStatus)

  return { teamState, status }
}
