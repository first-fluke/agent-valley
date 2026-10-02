"use client"

import type { ConnectionStatus, TeamState } from "../types/team"

interface TeamHudProps {
  teamState: TeamState | null
  connectionStatus: ConnectionStatus
  retryQueueSize?: number
  lastEventAt?: string | null
}

export function TeamHud({ teamState, connectionStatus, retryQueueSize, lastEventAt }: TeamHudProps) {
  const nodes = teamState?.nodes ?? []
  const totalSlots = nodes.filter((n) => n.online).reduce((sum, n) => sum + n.maxParallel, 0)
  const activeAgents = nodes.reduce((sum, n) => sum + n.activeIssues.length, 0)
  const idleSlots = Math.max(0, totalSlots - activeAgents)

  return (
    <div className="absolute top-4 right-4 bg-gray-800/90 rounded-lg p-4 min-w-56 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">Team Dashboard</h2>

      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-400">Connection</span>
          <span
            className={
              connectionStatus === "connected"
                ? "text-green-400"
                : connectionStatus === "connecting"
                  ? "text-yellow-400"
                  : "text-red-400"
            }
          >
            {connectionStatus}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Agents</span>
          <span className="text-white">
            {activeAgents} / {totalSlots}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Idle Slots</span>
          <span className={idleSlots > 0 ? "text-yellow-400" : "text-green-400"}>{idleSlots}</span>
        </div>

        {(retryQueueSize ?? 0) > 0 && (
          <div className="flex justify-between">
            <span className="text-gray-400">Retry Queue</span>
            <span className="text-yellow-400">{retryQueueSize}</span>
          </div>
        )}

        {lastEventAt && (
          <div className="flex justify-between">
            <span className="text-gray-400">Last Event</span>
            <span className="text-gray-300 text-[10px]">{new Date(lastEventAt).toLocaleTimeString()}</span>
          </div>
        )}
      </div>
    </div>
  )
}
