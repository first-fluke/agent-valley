import { useCallback, useEffect, useRef, useState } from "react"
import { useUnmount } from "ahooks"
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

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.close()
      sourceRef.current = null
    }
  }, [])

  const connect = useCallback(() => {
    cleanup()
    setStatus("connecting")

    const source = new EventSource(url)
    sourceRef.current = source

    source.onopen = () => {
      setStatus("open")
      attemptRef.current = 0
    }

    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as OrchestratorState
        setData(parsed)
      } catch {
        // skip malformed messages
      }
    }

    source.addEventListener("state", (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent).data) as OrchestratorState
        setData(parsed)
      } catch {
        // skip
      }
    })

    source.onerror = () => {
      source.close()
      setStatus("error")

      if (attemptRef.current < MAX_RECONNECT_ATTEMPTS) {
        attemptRef.current += 1
        reconnectTimerRef.current = setTimeout(connect, RECONNECT_DELAY_MS)
      } else {
        setStatus("closed")
      }
    }
  }, [url, cleanup])

  useEffect(() => {
    connect()
    return cleanup
  }, [connect, cleanup])

  useUnmount(cleanup)

  return { data, status, reconnect: connect }
}
