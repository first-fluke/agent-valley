"use client"

import { useMemo } from "react"
import type { OrchestratorState } from "@/features/office/types/agent"
import type { ConnectionStatus, TeamNode, TeamState } from "../types/team"

type SSEConnectionStatus = "connecting" | "open" | "closed" | "error"

function mapConnectionStatus(status: SSEConnectionStatus): ConnectionStatus {
  if (status === "open") return "connected"
  if (status === "error") return "error"
  if (status === "closed") return "disconnected"
  return "connecting"
}

/**
 * Derives TeamState from an already-open SSE OrchestratorState,
 * instead of opening a second EventSource connection.
 */
export function useLocalOrchestrator(data: OrchestratorState | null, sseStatus: SSEConnectionStatus) {
  const teamState = useMemo<TeamState | null>(() => {
    if (!data) return null

    const node: TeamNode = {
      nodeId: "local",
      displayName: "Local",
      defaultAgentType: data.config.agentType,
      maxParallel: data.config.maxParallel,
      online: data.isRunning && sseStatus === "open",
      joinedAt: "",
      activeIssues: data.activeWorkspaces
        .filter((ws) => ws.status === "running")
        .map((ws) => ({
          issueKey: ws.key,
          issueId: ws.issueId,
          agentType: ws.agentType ?? data.config.agentType,
          startedAt: ws.startedAt,
        })),
    }

    return { nodes: [node], lastSeq: 0 }
  }, [data, sseStatus])

  const status = mapConnectionStatus(sseStatus)

  return { teamState, status }
}
