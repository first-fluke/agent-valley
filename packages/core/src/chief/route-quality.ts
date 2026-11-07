import { DEFAULT_EVIDENCE_WINDOW, type RouteEvidence, type RouteOutcome, type RoutingCandidate } from "./operations"

/** Configured price sum; incomplete prices sort last and keep the configured candidate order. */
export function routePrice(candidate: RoutingCandidate): number {
  return candidate.inputPerMillionUsd !== undefined && candidate.outputPerMillionUsd !== undefined
    ? candidate.inputPerMillionUsd + candidate.outputPerMillionUsd
    : Number.POSITIVE_INFINITY
}

/**
 * Windowed quality decides eligibility. The window is exact only when recorded outcomes cover it,
 * or cover every counted sample. A record saved before windowing has no per-run history, so its
 * lifetime aggregate stays authoritative until enough new outcomes fill the window.
 */
export function routeQuality(
  record: RouteEvidence | undefined,
  window = DEFAULT_EVIDENCE_WINDOW,
): { samples: number; successes: number } {
  const lifetime = { samples: record?.samples ?? 0, successes: record?.successes ?? 0 }
  const recent = record?.recent?.slice(-window)
  if (!recent || (recent.length < window && recent.length < lifetime.samples)) return lifetime
  return { samples: recent.length, successes: recent.filter((entry) => entry.outcome === "passed").length }
}

/** Unmeasured routes sort below every measured route instead of claiming a zero success rate. */
export function routeSuccessRate(record: RouteEvidence | undefined, window = DEFAULT_EVIDENCE_WINDOW): number {
  const quality = routeQuality(record, window)
  return quality.samples ? quality.successes / quality.samples : -1
}

/** Replaces the array so a copied evidence record never writes into saved mission state. */
export function appendRouteOutcome(
  record: RouteEvidence,
  outcome: RouteOutcome,
  window = DEFAULT_EVIDENCE_WINDOW,
): void {
  record.recent = [...(record.recent ?? []), outcome].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-window)
}
