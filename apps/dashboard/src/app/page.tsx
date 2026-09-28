"use client"

import { useEffect, useState, type FormEvent } from "react"
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
import { useTeamLedger } from "@/features/team/hooks/use-team-ledger"

function StandaloneDashboard() {
  const { data, status, reconnect } = useOrchestratorSSE("/api/events")
  const { teamState: localTeamState, status: localTeamStatus } = useLocalOrchestrator(data, status)
  const team = useTeamLedger()
  const teamState = team.mode === "team" && team.status === "connected" ? team.teamState : localTeamState
  const teamStatus = team.mode === "team" && team.status === "connected" ? team.status : localTeamStatus
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
      {team.mode === "team" && team.error && (
        <p role="alert" className="absolute bottom-14 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded border border-red-700 bg-gray-950/95 px-4 py-2 text-sm text-red-200">
          {team.error}
        </p>
      )}
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
  const [session, setSession] = useState<{
    status: { required: boolean; authenticated: boolean }
    intervention: { required: boolean; authenticated: boolean }
  } | null>(null)
  const [statusToken, setStatusToken] = useState("")
  const [interventionToken, setInterventionToken] = useState("")
  const [error, setError] = useState("")

  const refresh = async () => {
    const response = await fetch("/api/auth/session", { cache: "no-store" })
    if (response.ok) setSession(await response.json())
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => clearInterval(timer)
  }, [])

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")
    const response = await fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(statusToken ? { statusToken } : {}),
        ...(interventionToken ? { interventionToken } : {}),
      }),
    })
    setStatusToken("")
    setInterventionToken("")
    if (!response.ok) {
      setError("Invalid dashboard credentials.")
      return
    }
    await refresh()
  }

  const signOut = async () => {
    await fetch("/api/auth/session", { method: "DELETE" })
    await refresh()
  }

  if (!session) return <main className="min-h-screen bg-gray-950 text-gray-100 p-8">Connecting…</main>
  if (session.status.authenticated && session.intervention.authenticated) {
    return (
      <>
        <StandaloneDashboard />
        {(session.status.required || session.intervention.required) && (
          <button type="button" onClick={() => void signOut()} className="fixed bottom-4 right-4 z-50 rounded bg-gray-800 px-3 py-2 text-sm text-gray-100 focus-visible:outline">
            Sign out
          </button>
        )}
      </>
    )
  }
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
      <form onSubmit={(event) => void login(event)} className="w-full max-w-sm space-y-4 rounded-lg border border-gray-700 bg-gray-900 p-6">
        <h1 className="text-xl font-semibold">Agent Valley dashboard</h1>
        {session.status.required && !session.status.authenticated && (
          <label className="block text-sm">Dashboard token
            <input aria-label="Dashboard token" type="password" autoComplete="off" required value={statusToken} onChange={(event) => setStatusToken(event.target.value)} className="mt-1 w-full rounded border border-gray-600 bg-gray-800 p-2" />
          </label>
        )}
        {session.intervention.required && !session.intervention.authenticated && (
          <label className="block text-sm">Intervention token
            <input aria-label="Intervention token" type="password" autoComplete="off" required value={interventionToken} onChange={(event) => setInterventionToken(event.target.value)} className="mt-1 w-full rounded border border-gray-600 bg-gray-800 p-2" />
          </label>
        )}
        {error && <p role="alert" className="text-red-300">{error}</p>}
        {session.status.required || session.intervention.required
          ? <button type="submit" className="rounded bg-blue-600 px-4 py-2 focus-visible:outline">Sign in</button>
          : <p>This dashboard is available only through its local listener.</p>}
      </form>
    </main>
  )
}
