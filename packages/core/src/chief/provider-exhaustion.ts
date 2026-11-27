import { handoffStateSchema } from "./handoff-contract"
import type { Mission } from "./types"

/** How long a usage-exhausted provider is assumed exhausted before a child tries it again. */
export const EXHAUSTION_WINDOW_MS = 6 * 60 * 60 * 1_000

export type ExhaustedProvider = { agentType: string; at: string }

/** Providers a recent child found usage-exhausted start the next child already handed off (6-hour window). */
export function seededExhaustion(
  operation: { exhaustedProviders?: ExhaustedProvider[] },
  now: string,
): Mission["handoff"] | undefined {
  const horizon = Date.parse(now) - EXHAUSTION_WINDOW_MS
  const exhaustedAgents = (operation.exhaustedProviders ?? [])
    .filter((entry) => Date.parse(entry.at) >= horizon)
    .map((entry) => entry.agentType)
  if (!exhaustedAgents.length) return undefined
  const parsed = handoffStateSchema.safeParse({ exhaustedAgents, routes: {}, continuations: {} })
  return parsed.success ? parsed.data : undefined
}

/**
 * Adds the providers a child holds as exhausted. A provider the child was started with, or one it
 * already reported, keeps the time it was first found: renewing it at every child would keep the
 * window open for good and the provider would never be tried again.
 */
export function recordExhaustion(
  recorded: ExhaustedProvider[],
  child: Pick<Mission, "createdAt" | "handoff">,
  now: string,
): ExhaustedProvider[] {
  const known = Date.parse(child.createdAt) - EXHAUSTION_WINDOW_MS
  const next = [...recorded]
  for (const agentType of child.handoff?.exhaustedAgents ?? []) {
    const index = next.findIndex((entry) => entry.agentType === agentType)
    if (index === -1) next.push({ agentType, at: now })
    else if (Date.parse(next[index]?.at ?? "") < known) next[index] = { agentType, at: now }
  }
  return next
}
