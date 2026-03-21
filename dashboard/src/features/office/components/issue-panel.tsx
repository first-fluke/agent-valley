"use client"

import type { ActiveWorkspace, WorkspaceStatus } from "@/features/office/types/agent"

interface IssuePanelProps {
  workspaces: ActiveWorkspace[]
}

const STATUS_STYLES: Record<WorkspaceStatus, string> = {
  idle: "bg-gray-600",
  running: "bg-blue-500",
  done: "bg-green-500",
  failed: "bg-red-500",
}

export function IssuePanel({ workspaces }: IssuePanelProps) {
  if (workspaces.length === 0) return null

  return (
    <div className="absolute bottom-4 left-4 bg-gray-800/90 rounded-lg p-4 min-w-64 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">Active Issues</h2>

      <div className="space-y-2">
        {workspaces.map((ws) => (
          <div
            key={ws.issueId}
            className="flex items-center gap-2 text-xs"
          >
            <span className={`w-2 h-2 rounded-full ${STATUS_STYLES[ws.status]}`} />
            <span className="text-white font-mono">{ws.key}</span>
            <span className="text-gray-400 ml-auto">{ws.status}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
