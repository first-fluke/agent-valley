"use client"

import { useEffect, useState } from "react"
import type { ConnectionStatus, TeamState } from "@/features/team/types/team"

interface TeamLedgerResponse {
  mode: "standalone" | "team"
  status?: "connected" | "error"
  state?: TeamState
  code?: string
  message?: string
}

/** Reads the local dashboard relay; Supabase credentials stay on the server. */
export function useTeamLedger() {
  const [teamState, setTeamState] = useState<TeamState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [mode, setMode] = useState<"standalone" | "team">("standalone")
  const [error, setError] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    let loading = false
    const sync = async () => {
      if (loading) return
      loading = true
      try {
        const response = await fetch("/api/team/ledger", { cache: "no-store" })
        const result = (await response.json()) as TeamLedgerResponse
        if (!active) return
        if (result.mode === "standalone") {
          setMode("standalone")
          setStatus("disconnected")
          setTeamState(null)
          setError(null)
          setErrorCode(null)
        } else if (result.mode === "team" && result.status === "connected" && result.state) {
          setMode("team")
          setStatus("connected")
          setTeamState(result.state)
          setError(null)
          setErrorCode(null)
        } else {
          setMode("team")
          setStatus("error")
          setTeamState(null)
          setError(result.message ?? "Team ledger is unavailable.")
          setErrorCode(result.code ?? "team_unavailable")
        }
      } catch {
        if (!active) return
        setMode("team")
        setStatus("error")
        setTeamState(null)
        setError("Cannot reach the team ledger. Check the dashboard connection.")
        setErrorCode("team_unavailable")
      } finally {
        loading = false
      }
    }

    void sync()
    const timer = setInterval(() => void sync(), 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])

  return { teamState, status, mode, error, errorCode }
}
