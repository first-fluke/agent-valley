import {
  applyThreadUpdate,
  type ThreadBacklog,
  type ThreadEntry,
  type ThreadUpdate,
} from "@agent-valley/core/domain/issue-thread"
import { useEffect, useState } from "react"

export type IssueThreadStatus = "connecting" | "open" | "reconnecting" | "closed"

/**
 * Follow one issue's thread over /api/thread. The browser's EventSource
 * reconnects on its own; every (re)connect starts with a `backlog` event that
 * replaces the local copy, so no resume bookkeeping is needed.
 */
export function useIssueThread(issueKey: string | null) {
  const [entries, setEntries] = useState<ThreadEntry[]>([])
  const [status, setStatus] = useState<IssueThreadStatus>("connecting")

  useEffect(() => {
    setEntries([])
    setStatus("connecting")
    if (!issueKey || typeof EventSource === "undefined") return

    const source = new EventSource(`/api/thread?issue=${encodeURIComponent(issueKey)}`)

    source.onopen = () => setStatus("open")
    source.addEventListener("backlog", (event) => {
      try {
        setEntries((JSON.parse((event as MessageEvent).data) as ThreadBacklog).entries)
      } catch {
        // Skip a malformed frame; the next reconnect resends the backlog.
      }
    })
    source.addEventListener("entry", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent).data) as ThreadUpdate
        setEntries((current) => applyThreadUpdate(current, update))
      } catch {
        // Skip a malformed frame.
      }
    })
    // CLOSED means the server refused the stream (auth, bad request); the
    // browser will not retry. Any other state is a transient drop.
    source.onerror = () => setStatus(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting")

    return () => source.close()
  }, [issueKey])

  return { entries, status }
}
