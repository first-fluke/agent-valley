"use client"

import type { ActiveAttempt } from "@/features/orchestrator/components/intervention-panel"
import type { RunningWorkspace } from "@/features/orchestrator/types/orchestrator.types"

interface ActiveAgentsPanelProps {
  workspaces: RunningWorkspace[]
  selectedAttemptId: string | null
  onSelect: (attempt: ActiveAttempt) => void
}

/**
 * Lists running agent attempts and lets the operator select one to open
 * the InterventionPanel drawer. Only workspaces with a live `attemptId`
 * are selectable (a workspace can be queued/idle without an attempt yet).
 */
export function ActiveAgentsPanel({ workspaces, selectedAttemptId, onSelect }: ActiveAgentsPanelProps) {
  const running = workspaces.filter((ws): ws is RunningWorkspace & { attemptId: string } => Boolean(ws.attemptId))

  if (running.length === 0) return null

  return (
    <div className="absolute bottom-4 left-4 bg-gray-800/90 rounded-lg p-4 min-w-64 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">Active Agents</h2>
      <ul className="space-y-1">
        {running.map((ws) => {
          const isSelected = ws.attemptId === selectedAttemptId
          return (
            <li key={ws.attemptId}>
              <button
                type="button"
                aria-pressed={isSelected}
                aria-haspopup="dialog"
                onClick={() =>
                  onSelect({
                    attemptId: ws.attemptId,
                    issueKey: ws.key,
                    agentType: ws.agentType ?? "claude",
                  })
                }
                className={`w-full flex items-center justify-between gap-2 rounded px-2 py-1.5 text-xs text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 ${
                  isSelected
                    ? "bg-blue-700/40 text-blue-100"
                    : "bg-gray-900/60 text-gray-200 hover:bg-gray-700/60"
                }`}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" aria-hidden="true" />
                  <span className="font-mono truncate">{ws.key}</span>
                </span>
                <span className="text-gray-500 shrink-0">{ws.agentType ?? "unknown"}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
