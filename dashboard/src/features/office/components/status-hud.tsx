"use client"

import type { OrchestratorState } from "@/features/office/types/agent"

interface StatusHudProps {
  state: OrchestratorState | null
  connectionStatus: string
}

export function StatusHud({ state, connectionStatus }: StatusHudProps) {
  return (
    <div className="absolute top-4 right-4 bg-gray-800/90 rounded-lg p-4 min-w-56 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">Orchestrator</h2>

      <div className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-gray-400">Status</span>
          <span className={state?.isRunning ? "text-green-400" : "text-gray-500"}>
            {state?.isRunning ? "Running" : "Stopped"}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Connection</span>
          <span className={
            connectionStatus === "open"
              ? "text-green-400"
              : connectionStatus === "connecting"
                ? "text-yellow-400"
                : "text-red-400"
          }>
            {connectionStatus}
          </span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Agent</span>
          <span className="text-white">{state?.config.agentType ?? "-"}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Active</span>
          <span className="text-white">{state?.activeAgents ?? 0} / {state?.config.maxParallel ?? 0}</span>
        </div>

        <div className="flex justify-between">
          <span className="text-gray-400">Retry Queue</span>
          <span className="text-white">{state?.retryQueueSize ?? 0}</span>
        </div>

        {state?.lastEventAt && (
          <div className="flex justify-between">
            <span className="text-gray-400">Last Event</span>
            <span className="text-gray-300 text-[10px]">
              {new Date(state.lastEventAt).toLocaleTimeString()}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
