"use client"

import { useEffect, useState } from "react"
import { PixiCanvas } from "@/components/pixi-canvas"
import { SystemMetricsPanel } from "@/features/office/components/system-metrics-panel"
import { ActiveAgentsPanel } from "@/features/orchestrator/components/active-agents-panel"
import { ConnectionStatus as ConnectionStatusBar } from "@/features/orchestrator/components/connection-status"
import type { ActiveAttempt } from "@/features/orchestrator/components/intervention-panel"
import { InterventionPanel } from "@/features/orchestrator/components/intervention-panel"
import type { RunningWorkspace } from "@/features/orchestrator/types/orchestrator.types"
import { useOrchestratorSSE } from "@/features/orchestrator/utils/use-orchestrator-sse"
import { TeamHud } from "@/features/team/components/team-hud"
import { TeamPanel } from "@/features/team/components/team-panel"
import { useLocalOrchestrator } from "@/features/team/hooks/use-local-orchestrator"

function StandaloneDashboard() {
  const { data, status, reconnect } = useOrchestratorSSE("/api/events")
  const { teamState, status: teamStatus } = useLocalOrchestrator(data, status)
  const [selectedAttempt, setSelectedAttempt] = useState<ActiveAttempt | null>(null)

  // The wire type (see `orchestrator.types.ts`) carries `attemptId`/`agentType`
  // even though `OrchestratorState.activeWorkspaces` is typed narrower.
  const workspaces = (data?.activeWorkspaces ?? []) as RunningWorkspace[]

  // If the selected attempt's workspace disappears from the live SSE state
  // (agent finished, failed, or was aborted), close the drawer instead of
  // leaving it open against a dead attempt.
  useEffect(() => {
    if (!selectedAttempt) return
    const stillActive = workspaces.some((ws) => ws.attemptId === selectedAttempt.attemptId)
    if (!stillActive) setSelectedAttempt(null)
  }, [workspaces, selectedAttempt])

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-gray-950">
      <PixiCanvas state={data} />
      <TeamHud
        teamState={teamState}
        connectionStatus={teamStatus}
        retryQueueSize={data?.retryQueueSize}
        lastEventAt={data?.lastEventAt}
      />
      <TeamPanel teamState={teamState} />
      <ActiveAgentsPanel
        workspaces={workspaces}
        selectedAttemptId={selectedAttempt?.attemptId ?? null}
        onSelect={setSelectedAttempt}
      />
      <SystemMetricsPanel metrics={data?.systemMetrics} />
      <ConnectionStatusBar status={status} onReconnect={reconnect} />
      <InterventionPanel attempt={selectedAttempt} onClose={() => setSelectedAttempt(null)} />
    </main>
  )
}

export default function DashboardPage() {
  return <StandaloneDashboard />
}
