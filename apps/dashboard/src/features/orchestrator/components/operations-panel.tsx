import type { OrchestratorState } from "@/features/office/types/agent"

interface OperationsPanelProps {
  state: OrchestratorState | null
  runtimeError: string | null
  connected: boolean
}

export function OperationsPanel({ state, runtimeError, connected }: OperationsPanelProps) {
  const failed = state?.activeWorkspaces.filter((workspace) => workspace.status === "failed") ?? []
  const waiting = state?.waitingIssueDetails ?? []
  const retries = state?.retryQueue ?? []
  const running = connected && state?.isRunning === true

  return (
    <section
      aria-label="Orchestrator operations"
      className="rounded-lg border border-gray-700 bg-gray-950/95 p-4 text-xs text-gray-200"
    >
      <h2 className="mb-2 text-sm font-semibold">Orchestrator</h2>
      <p className={running ? "text-green-300" : "text-yellow-300"}>
        {runtimeError
          ? "Unavailable"
          : !connected
            ? "Disconnected — status may be stale"
            : !state
              ? "Waiting for runtime status"
              : running
                ? "Running"
                : "Stopped"}
      </p>
      {runtimeError && (
        <p role="alert" className="mt-2 leading-relaxed text-red-200">
          {runtimeError}
        </p>
      )}
      {connected && state && !running && (
        <p role="alert" className="mt-2">
          Restart <code>av up</code> to resume processing issues.
        </p>
      )}
      {state && (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-2">
            <dt>Active agents</dt>
            <dd>
              {state.activeAgents} / {state.config.maxParallel}
            </dd>
            <dt>Waiting issues</dt>
            <dd>{state.waitingIssues ?? waiting.length}</dd>
            <dt>Scheduled retries</dt>
            <dd>{state.retryQueueSize}</dd>
          </dl>
          {running && state.activeAgents === 0 && !state.waitingIssues && state.retryQueueSize === 0 && (
            <p className="mt-3 text-gray-400">
              No work queued. Move an eligible tracker issue to Todo. Run <code>av doctor</code> if it does not appear.
            </p>
          )}
          {waiting.length > 0 && (
            <div className="mt-3">
              <h3 className="font-semibold">Waiting</h3>
              <ul className="mt-1 space-y-2">
                {waiting.map((issue) => (
                  <li key={issue.issueId} className="break-words">
                    <span className="font-mono">{issue.identifier}</span>:{" "}
                    {issue.blockedBy.length
                      ? `Blocked by ${issue.blockedBy.join(", ")}`
                      : "Ready; waiting for dispatch"}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {retries.length > 0 && (
            <div className="mt-3">
              <h3 className="font-semibold">Retries</h3>
              <ul className="mt-1 space-y-2">
                {retries.map((retry) => (
                  <li key={retry.issueId} className="break-words">
                    <p className="font-mono">
                      {retry.issueId} · attempt {retry.attemptCount}
                    </p>
                    <p>{retry.lastError}</p>
                    <p className="text-gray-400">
                      {retry.category} · next{" "}
                      <time dateTime={retry.nextRetryAt}>{new Date(retry.nextRetryAt).toLocaleString()}</time>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {failed.length > 0 && (
            <p role="alert" className="mt-3 text-red-200">
              Failed workspaces: {failed.map((workspace) => workspace.key).join(", ")}. Inspect the issue comments and
              server log before retrying.
            </p>
          )}
        </>
      )}
    </section>
  )
}
