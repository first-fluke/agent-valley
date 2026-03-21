import { useEffect, useRef, useState } from "react"
import type { OrchestratorState } from "@/features/office/types/agent"

type ConnectionStatus = "connecting" | "open" | "closed" | "error"

const RECONNECT_DELAY_MS = 3000
const MAX_RECONNECT_ATTEMPTS = 10

export function useOrchestratorSSE(url: string) {
  const [data, setData] = useState<OrchestratorState | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>("connecting")
  const sourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const reconnectRef = useRef<() => void>(() => {})

  // W-9 fix: stable ref avoids useCallback dependency cycle + Strict Mode double-connect
  const urlRef = useRef(url)
  urlRef.current = url

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

      const source = new EventSource(urlRef.current)
      sourceRef.current = source

      source.onopen = () => {
        if (!active) return
        setStatus("open")
        attemptRef.current = 0
      }

      source.addEventListener("state", (event) => {
        if (!active) return
        try {
          const parsed = JSON.parse((event as MessageEvent).data) as OrchestratorState
          setData(parsed)
        } catch {
          // skip malformed
        }
      })

      source.onerror = () => {
        source.close()
        if (!active) return
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
    reconnectRef.current = connect

    return () => {
      active = false
      cleanup()
    }
  }, [])

  return {
    data,
    status,
    reconnect: () => reconnectRef.current(),
  }
}
