/**
 * Next.js Instrumentation — bootstraps the Orchestrator on server start.
 *
 * This runs once when the Next.js server starts. It initializes the
 * Symphony Orchestrator singleton so Route Handlers can access it.
 *
 * TODO: Wire up the actual Orchestrator from ../src/ once the
 * dashboard is integrated into the monorepo. For now, this provides
 * a mock orchestrator for UI development.
 */

export async function register() {
  // Only run on the server
  if (typeof window !== "undefined") return

  const { setOrchestrator } = await import("@/lib/orchestrator-singleton")

  // Mock orchestrator for standalone dashboard development
  const mockState = {
    isRunning: true,
    lastEventAt: new Date().toISOString(),
    activeWorkspaces: [
      {
        issueId: "mock-1",
        key: "FIR-3",
        status: "running" as const,
        startedAt: new Date().toISOString(),
      },
    ],
    activeAgents: 1,
    retryQueueSize: 0,
    config: {
      agentType: "claude" as const,
      maxParallel: 3,
      serverPort: 3000,
    },
  }

  setOrchestrator({
    getStatus: () => mockState,
    handleWebhook: async (_payload: string, _signature: string) => {
      return { status: 200, body: JSON.stringify({ ok: true }) }
    },
  })

  console.log("[instrumentation] Orchestrator initialized (mock mode)")
}
