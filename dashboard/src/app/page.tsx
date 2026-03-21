"use client"

import { PixiCanvas } from "@/components/pixi-canvas"
import { StatusHud } from "@/features/office/components/status-hud"
import { IssuePanel } from "@/features/office/components/issue-panel"
import { ConnectionStatus } from "@/features/orchestrator/components/connection-status"
import { useOrchestratorSSE } from "@/features/orchestrator/utils/use-orchestrator-sse"

export default function DashboardPage() {
  const { data, status, reconnect } = useOrchestratorSSE("/api/events")

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-gray-950">
      <PixiCanvas state={data} />
      <StatusHud state={data} connectionStatus={status} />
      <IssuePanel workspaces={data?.activeWorkspaces ?? []} />
      <ConnectionStatus status={status} onReconnect={reconnect} />
    </main>
  )
}
