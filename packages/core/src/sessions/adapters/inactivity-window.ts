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

const REVIEW_INACTIVITY_TIMEOUT_SEC = 600

/**
 * A reviewer reads files and returns a short verdict, so its native CLI keeps emitting tool events; one that
 * is silent for ten minutes is hung, and waiting the full window cost thirty idle minutes per hung review.
 * Work runs long silent commands, and planning or recovery generates one large response without
 * intermediate events (a healthy plan was silent for over ten minutes), so those keep the full window.
 */
export function stageInactivityTimeoutSec(stage: string | undefined, source: NodeJS.ProcessEnv = process.env): number {
  const general = resolveInactivityTimeoutSec(undefined, source)
  if (!general || !stage || !/(?:^|-)review$/.test(stage)) return general
  return Math.min(general, REVIEW_INACTIVITY_TIMEOUT_SEC)
}
