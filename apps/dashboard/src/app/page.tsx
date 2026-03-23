"use client"

import { PixiCanvas } from "@/components/pixi-canvas"
import { StatusHud } from "@/features/office/components/status-hud"
import { IssuePanel } from "@/features/office/components/issue-panel"
import { SystemMetricsPanel } from "@/features/office/components/system-metrics-panel"
import { ConnectionStatus as ConnectionStatusBar } from "@/features/orchestrator/components/connection-status"
import { useOrchestratorSSE } from "@/features/orchestrator/utils/use-orchestrator-sse"
import { TeamHud } from "@/features/team/components/team-hud"
import { TeamPanel } from "@/features/team/components/team-panel"
import { useLocalOrchestrator } from "@/features/team/hooks/use-local-orchestrator"

function StandaloneDashboard() {
  const { data, status, reconnect } = useOrchestratorSSE("/api/events")
  const { teamState, status: teamStatus } = useLocalOrchestrator(data, status)

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-gray-950">
      <PixiCanvas state={data} />
      <TeamHud teamState={teamState} connectionStatus={teamStatus} />
      <TeamPanel teamState={teamState} />
      <SystemMetricsPanel metrics={data?.systemMetrics} />
      <ConnectionStatusBar status={status} onReconnect={reconnect} />
    </main>
  )
}

export default function DashboardPage() {
  return <StandaloneDashboard />
}
