const DEFAULT_INACTIVITY_TIMEOUT_SEC = 1_800

/** A native CLI that stops emitting events for this long is hung, not thinking. */
export function resolveInactivityTimeoutSec(
  requested: number | undefined,
  source: NodeJS.ProcessEnv = process.env,
): number {
  const configured = Number.parseInt(source.AV_AGENT_INACTIVITY_TIMEOUT_SEC ?? "", 10)
  const seconds = requested ?? (Number.isFinite(configured) ? configured : DEFAULT_INACTIVITY_TIMEOUT_SEC)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0
}

const READ_ONLY_INACTIVITY_TIMEOUT_SEC = 600

/**
 * Only a work stage runs long commands that print nothing. A planner or reviewer reads and reasons, so the
 * native CLI keeps emitting protocol events; one that is silent for ten minutes is hung. Waiting the full
 * work window there cost thirty idle minutes per hung review.
 */
export function stageInactivityTimeoutSec(stage: string | undefined, source: NodeJS.ProcessEnv = process.env): number {
  const general = resolveInactivityTimeoutSec(undefined, source)
  if (!general || !stage || stage === "work") return general
  return Math.min(general, READ_ONLY_INACTIVITY_TIMEOUT_SEC)
}
