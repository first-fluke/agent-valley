"use client"

import { type FormEvent, useCallback, useEffect, useState } from "react"
import { PixiCanvas } from "@/components/pixi-canvas"
import { SystemMetricsPanel } from "@/features/office/components/system-metrics-panel"
import { ActiveAgentsPanel } from "@/features/orchestrator/components/active-agents-panel"
import { ConnectionStatus as ConnectionStatusBar } from "@/features/orchestrator/components/connection-status"
import type { ActiveAttempt } from "@/features/orchestrator/components/intervention-panel"
import { InterventionPanel } from "@/features/orchestrator/components/intervention-panel"
import { OperationsPanel } from "@/features/orchestrator/components/operations-panel"
import type { RunningWorkspace } from "@/features/orchestrator/types/orchestrator.types"
import { useOrchestratorSSE } from "@/features/orchestrator/utils/use-orchestrator-sse"
import { TeamHud } from "@/features/team/components/team-hud"
import { TeamPanel } from "@/features/team/components/team-panel"
import { useLocalOrchestrator } from "@/features/team/hooks/use-local-orchestrator"
import { useTeamLedger } from "@/features/team/hooks/use-team-ledger"

function StandaloneDashboard({ canIntervene }: { canIntervene: boolean }) {
  const { data, status, runtimeError, reconnect } = useOrchestratorSSE("/api/events")
  const { teamState: localTeamState, status: localTeamStatus } = useLocalOrchestrator(data, status)
  const team = useTeamLedger()
  const teamState = team.mode === "team" && team.status === "connected" ? team.teamState : localTeamState
  const teamStatus = team.mode === "team" && team.status === "connected" ? team.status : localTeamStatus
  const [selectedAttempt, setSelectedAttempt] = useState<ActiveAttempt | null>(null)
  const closeIntervention = useCallback(() => setSelectedAttempt(null), [])

  const workspaces = (data?.activeWorkspaces ?? []) as RunningWorkspace[]

  // If the selected attempt's workspace disappears from the live SSE state
  // (agent finished, failed, or was aborted), close the drawer instead of
  // leaving it open against a dead attempt.
  useEffect(() => {
    if (!selectedAttempt) return
    const stillActive =
      canIntervene && status === "open" && workspaces.some((ws) => ws.attemptId === selectedAttempt.attemptId)
    if (!stillActive) setSelectedAttempt(null)
  }, [workspaces, selectedAttempt, canIntervene, status])

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-gray-950">
      <PixiCanvas state={data} />
      <TeamHud
        teamState={teamState}
        connectionStatus={teamStatus}
        retryQueueSize={data?.retryQueueSize}
        lastEventAt={data?.lastEventAt}
      />
      <div className="absolute inset-y-4 left-4 z-10 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-y-auto">
        <OperationsPanel state={data} runtimeError={runtimeError} connected={status === "open"} />
        <TeamPanel teamState={teamState} />
        <ActiveAgentsPanel
          workspaces={workspaces}
          selectedAttemptId={selectedAttempt?.attemptId ?? null}
          onSelect={setSelectedAttempt}
          canIntervene={canIntervene && status === "open"}
        />
      </div>
      {team.mode === "team" && team.error && (
        <p
          role="alert"
          className="absolute bottom-14 left-1/2 z-40 max-w-lg -translate-x-1/2 rounded border border-red-700 bg-gray-950/95 px-4 py-2 text-sm text-red-200"
        >
          {team.error}
        </p>
      )}
      <SystemMetricsPanel metrics={data?.systemMetrics} />
      <ConnectionStatusBar status={status} onReconnect={reconnect} />
      <InterventionPanel attempt={selectedAttempt} onClose={closeIntervention} />
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
  const [showCredentials, setShowCredentials] = useState(false)
  const [busy, setBusy] = useState(false)

  const refresh = async () => {
    try {
      const response = await fetch("/api/auth/session", { cache: "no-store", signal: AbortSignal.timeout(10_000) })
      if (!response.ok)
        throw new Error(`Session check failed (${response.status}). Check that av up is running, then retry.`)
      setSession(await response.json())
      setError("")
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Cannot reach the dashboard. Check that av up is running, then retry.",
      )
    }
  }
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 60_000)
    return () => clearInterval(timer)
  }, [])

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError("")
    setBusy(true)
    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          ...(statusToken ? { statusToken } : {}),
          ...(interventionToken ? { interventionToken } : {}),
        }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string }
        throw new Error(body.message ?? `Sign in failed (${response.status}). Retry with valid dashboard credentials.`)
      }
      await refresh()
      setShowCredentials(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign in failed. Check the connection and retry.")
    } finally {
      setStatusToken("")
      setInterventionToken("")
      setBusy(false)
    }
  }

  const signOut = async () => {
    try {
      const response = await fetch("/api/auth/session", { method: "DELETE", signal: AbortSignal.timeout(10_000) })
      if (!response.ok) throw new Error(`Sign out failed (${response.status}). Retry.`)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign out failed. Check the connection and retry.")
    }
  }

  if (!session)
    return (
      <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button type="button" onClick={() => void refresh()} className="mt-4 rounded bg-blue-600 px-4 py-2">
              Retry connection
            </button>
          </>
        ) : (
          "Connecting…"
        )}
      </main>
    )
  if (session.status.authenticated && !showCredentials) {
    return (
      <>
        <StandaloneDashboard canIntervene={session.intervention.authenticated} />
        {error && (
          <p
            role="alert"
            className="fixed bottom-16 left-1/2 z-50 max-w-lg -translate-x-1/2 rounded bg-red-950 px-4 py-2 text-sm text-red-100"
          >
            {error}
          </p>
        )}
        <div className="fixed bottom-4 right-4 z-50 flex gap-2 text-sm text-gray-100">
          {!session.intervention.authenticated && session.intervention.required && (
            <button
              type="button"
              onClick={() => setShowCredentials(true)}
              className="rounded bg-blue-700 px-3 py-2 focus-visible:outline"
            >
              Enable controls
            </button>
          )}
          {(session.status.required || session.intervention.required) && (
            <button
              type="button"
              onClick={() => void signOut()}
              className="rounded bg-gray-800 px-3 py-2 focus-visible:outline"
            >
              Sign out
            </button>
          )}
        </div>
      </>
    )
  }
  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-6">
      <form
        onSubmit={(event) => void login(event)}
        className="w-full max-w-sm space-y-4 rounded-lg border border-gray-700 bg-gray-900 p-6"
      >
        <h1 className="text-xl font-semibold">Agent Valley dashboard</h1>
        {session.status.required && !session.status.authenticated && (
          <label className="block text-sm">
            Dashboard token
            <input
              aria-label="Dashboard token"
              type="password"
              autoComplete="off"
              required
              value={statusToken}
              onChange={(event) => setStatusToken(event.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-800 p-2"
            />
          </label>
        )}
        {session.intervention.required && !session.intervention.authenticated && (
          <label className="block text-sm">
            Intervention token {session.status.authenticated ? "" : "(optional for read-only access)"}
            <input
              aria-label="Intervention token"
              type="password"
              autoComplete="off"
              required={session.status.authenticated}
              value={interventionToken}
              onChange={(event) => setInterventionToken(event.target.value)}
              className="mt-1 w-full rounded border border-gray-600 bg-gray-800 p-2"
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        {session.status.required || session.intervention.required ? (
          <button
            type="submit"
            disabled={busy}
            className="rounded bg-blue-600 px-4 py-2 focus-visible:outline disabled:opacity-50"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        ) : (
          <p>
            Open this dashboard through localhost, or configure SYMPHONY_DASHBOARD_TOKEN to enable authenticated remote
            access.
          </p>
        )}
        {session.status.authenticated && (
          <button
            type="button"
            onClick={() => {
              setShowCredentials(false)
              setError("")
            }}
            className="ml-3 rounded bg-gray-700 px-4 py-2"
          >
            Continue read-only
          </button>
        )}
      </form>
    </main>
  )
}
