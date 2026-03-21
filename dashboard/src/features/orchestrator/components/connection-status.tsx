"use client"

interface ConnectionStatusProps {
  status: string
  onReconnect: () => void
}

export function ConnectionStatus({ status, onReconnect }: ConnectionStatusProps) {
  if (status === "open") return null

  return (
    <div className="absolute top-4 left-4 bg-gray-800/90 rounded-lg px-3 py-2 border border-gray-700 flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${
        status === "connecting" ? "bg-yellow-400 animate-pulse" : "bg-red-400"
      }`} />
      <span className="text-xs text-gray-300">
        {status === "connecting" ? "Connecting..." : "Disconnected"}
      </span>
      {status === "error" || status === "closed" ? (
        <button
          onClick={onReconnect}
          className="text-xs text-blue-400 hover:text-blue-300 ml-1"
        >
          Retry
        </button>
      ) : null}
    </div>
  )
}
