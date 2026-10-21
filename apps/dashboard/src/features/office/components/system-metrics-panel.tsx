"use client"

import type { SystemMetrics } from "@/features/office/types/agent"

interface SystemMetricsPanelProps {
  metrics: SystemMetrics | undefined
}

function formatGB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0

  return (
    <div className="h-2 w-full rounded-full bg-gray-700">
      <div
        className={`h-2 rounded-full bar-stripe ${color}`}
        style={{ width: `${pct}%`, transition: "width 0.5s ease" }}
      />
    </div>
  )
}

export function SystemMetricsPanel({ metrics }: SystemMetricsPanelProps) {
  if (!metrics) return null

  const memPct = metrics.memoryTotal > 0 ? Math.round((metrics.memoryRss / metrics.memoryTotal) * 100) : 0

  const cpuPct = metrics.cpuUser

  return (
    <div className="absolute bottom-4 right-4 bg-gray-800/90 rounded-lg p-4 min-w-56 border border-gray-700">
      <h2 className="text-sm font-bold text-gray-300 mb-3">System</h2>

      <div className="space-y-3 text-xs">
        {/* Memory */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-gray-400">Memory</span>
            <span className="text-white">
              {formatGB(metrics.memoryRss)} / {formatGB(metrics.memoryTotal)}
              <span className="text-gray-500 ml-1">({memPct}%)</span>
            </span>
          </div>
          <Bar
            value={metrics.memoryRss}
            max={metrics.memoryTotal}
            color={memPct > 85 ? "bg-red-500" : memPct > 60 ? "bg-yellow-500" : "bg-green-500"}
          />
        </div>

        {/* CPU */}
        <div>
          <div className="flex justify-between mb-1">
            <span className="text-gray-400">CPU</span>
            <span className="text-white">{cpuPct}%</span>
          </div>
          <Bar
            value={cpuPct}
            max={100}
            color={cpuPct > 85 ? "bg-red-500" : cpuPct > 60 ? "bg-yellow-500" : "bg-blue-500"}
          />
        </div>
      </div>
    </div>
  )
}
