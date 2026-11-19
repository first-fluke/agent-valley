"use client"

import type { ThreadEntry } from "@agent-valley/core/domain/issue-thread"
import { useEffect, useRef } from "react"
import type { IssueThreadStatus } from "@/features/orchestrator/utils/use-issue-thread"

interface IssueThreadLogProps {
  entries: ThreadEntry[]
  status: IssueThreadStatus
}

/** Distance from the bottom within which new entries keep the log pinned to the latest. */
const PIN_THRESHOLD_PX = 48

const STATUS_NOTE: Record<Exclude<IssueThreadStatus, "open">, string> = {
  connecting: "Connecting to the live thread…",
  reconnecting: "Connection lost. Reconnecting…",
  closed: "Live thread unavailable. Check dashboard access, then reopen this panel.",
}

/**
 * The running conversation for one issue: what the actor said and did, what
 * the operator sent, and lifecycle markers in between.
 */
export function IssueThreadLog({ entries, status }: IssueThreadLogProps) {
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow new activity unless the reader scrolled up to look at history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run whenever the thread content changes
  useEffect(() => {
    const log = logRef.current
    if (log && pinnedRef.current) log.scrollTop = log.scrollHeight
  }, [entries])

  const onScroll = () => {
    const log = logRef.current
    if (log) pinnedRef.current = log.scrollHeight - log.scrollTop - log.clientHeight <= PIN_THRESHOLD_PX
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {status !== "open" && (
        <p role="status" className="border-b border-gray-800 px-4 py-1.5 text-[11px] text-gray-400">
          {STATUS_NOTE[status]}
        </p>
      )}
      <div
        ref={logRef}
        role="log"
        aria-label="Actor activity"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400"
      >
        {entries.length === 0 ? (
          <p className="text-xs text-gray-500">No activity yet. Output appears here as the actor works.</p>
        ) : (
          entries.map((entry) => <ThreadEntryRow key={entry.seq} entry={entry} />)
        )}
      </div>
    </div>
  )
}

function ThreadEntryRow({ entry }: { entry: ThreadEntry }) {
  const time = formatTime(entry.at)

  if (entry.kind === "operator") {
    return (
      <div className="flex justify-end">
        <p
          title={time}
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg rounded-br-sm bg-blue-700/40 px-3 py-2 text-xs leading-relaxed text-blue-50"
        >
          <span className="sr-only">Operator: </span>
          {entry.text}
        </p>
      </div>
    )
  }

  if (entry.kind === "system") {
    return (
      <p title={time} className="flex items-center gap-2 text-[11px] text-gray-500">
        <span className="h-px flex-1 bg-gray-800" aria-hidden="true" />
        <span>{entry.text}</span>
        <span className="h-px flex-1 bg-gray-800" aria-hidden="true" />
      </p>
    )
  }

  if (entry.kind === "tool") {
    return (
      <p title={time} className="truncate font-mono text-[11px] text-gray-400">
        <span aria-hidden="true">▸ </span>
        <span className="sr-only">Tool: </span>
        {entry.text}
      </p>
    )
  }

  return (
    <p title={time} className="whitespace-pre-wrap break-words text-xs leading-relaxed text-gray-100">
      <span className="sr-only">Actor: </span>
      {entry.text}
    </p>
  )
}

function formatTime(at: string): string {
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString()
}
