import { useEffect, useRef, useState } from "react"
import type { OrchestratorState } from "@/features/office/types/agent"

type ConnectionStatus = "connecting" | "open" | "closed" | "error"

const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 10

export function useOrchestratorSSE(url: string) {
  const [data, setData] = useState<OrchestratorState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const [runtimeError, setRuntimeError] = useState<string | null>(null)
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const reconnectRef = useRef<() => void>(() => {})

  useEffect(() => {
    let active = true

    const cleanup = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
      if (sourceRef.current) {
        sourceRef.current.close()
        sourceRef.current = null
      }
    }

    const connect = () => {
      cleanup()
      if (!active) return

      setStatus("connecting")

      const source = new EventSource(url)
      sourceRef.current = source

      source.onopen = () => {
        if (!active || sourceRef.current !== source) return
        setStatus("open")
        attemptRef.current = 0
      }

      source.addEventListener("state", (event) => {
        if (!active || sourceRef.current !== source) return
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as OrchestratorState
          setData(parsed)
          setRuntimeError(null)
        } catch {
          // skip malformed
        }
      })

      source.addEventListener("unavailable", (event) => {
        if (!active || sourceRef.current !== source) return
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as { message?: string }
          setRuntimeError(parsed.message ?? "Orchestrator is unavailable. Run av doctor and restart av up.")
          setData(null)
        } catch {
          // Ignore malformed events; the next poll carries the current status.
        }
      })

      source.onerror = () => {
        source.close()
        if (!active || sourceRef.current !== source) return
        setStatus("error")

        if (attemptRef.current < MAX_RECONNECT_ATTEMPTS) {
          attemptRef.current += 1
          reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS)
        } else {
          setStatus("closed")
        }
      }
    }

    connect()
    reconnectRef.current = () => {
      attemptRef.current = 0
      connect()
    }

    return () => {
      active = false
      cleanup()
    }
  }, [url])

  return {
    data,
    status,
    runtimeError,
    reconnect: () => reconnectRef.current(),
  }
}
