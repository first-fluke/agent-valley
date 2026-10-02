"use client"

import type { TeamState } from "../types/team"

interface TeamPanelProps {
  teamState: TeamState | null
}

export function TeamPanel({ teamState }: TeamPanelProps) {
  const nodes = teamState?.nodes ?? []
  if (nodes.length === 0) return null

  return (
    <div className="bg-gray-800/90 rounded-lg p-4 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">Team Members</h2>

      <div className="space-y-3">
        {nodes.map((node) => (
          <div key={node.nodeId} className="text-xs">
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${node.online ? "bg-green-400" : "bg-gray-600"}`} />
              <span className="text-white font-medium">{node.displayName}</span>
              <span className="text-gray-500 text-[10px]">{node.defaultAgentType}</span>
              <span className="text-gray-400 ml-auto">
                {node.activeIssues.length}/{node.maxParallel}
              </span>
            </div>

            {node.activeIssues.length > 0 && (
              <div className="ml-4 space-y-1">
                {node.activeIssues.map((issue) => (
                  <div key={issue.issueKey} className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
                    <span className="text-gray-300 font-mono">{issue.issueKey}</span>
                    <span className="text-gray-500 text-[10px]">{issue.agentType}</span>
                  </div>
                ))}
              </div>
            )}

            {node.online && node.activeIssues.length === 0 && <div className="ml-4 text-gray-500 italic">idle</div>}

            {!node.online && <div className="ml-4 text-gray-600 italic">offline</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
