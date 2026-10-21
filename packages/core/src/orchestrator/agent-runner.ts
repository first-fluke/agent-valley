/**
 * Compatibility re-export.
 *
 * AgentRunnerService manages agent subprocesses (infrastructure) and now lives
 * in `sessions/adapters/agent-runner-service.ts`. New code should import from
 * there; this shim keeps existing orchestrator imports working.
 */
export * from "../sessions/adapters/agent-runner-service"
