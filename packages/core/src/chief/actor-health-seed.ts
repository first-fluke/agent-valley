import type { ProviderHealthEvidence, RouteEvidence } from "./operations"

const routeKey = (route: { actorType: string; model?: string }) =>
  JSON.stringify([route.actorType, route.model ?? null])

/** Operational health is independent of business memory and quality/cost samples. */
export function mergeProviderHealthSnapshots(
  previous: readonly ProviderHealthEvidence[],
  updates: readonly ProviderHealthEvidence[],
): ProviderHealthEvidence[] {
  const merged = new Map<string, ProviderHealthEvidence>()
  for (const route of [...previous, ...updates]) {
    const key = routeKey(route)
    const existing = merged.get(key)
    if (existing && Date.parse(existing.providerHealth.lastOutcomeAt) > Date.parse(route.providerHealth.lastOutcomeAt))
      continue
    merged.set(key, {
      actorType: route.actorType,
      ...(route.model ? { model: route.model } : {}),
      providerHealth: { ...route.providerHealth },
    })
  }
  return [...merged.values()]
}

/** Keep supplied quality measurements intact while attaching the newest health. */
export function seedProviderHealthEvidence(
  quality: readonly RouteEvidence[],
  health: readonly ProviderHealthEvidence[],
): RouteEvidence[] {
  const merged = new Map(quality.map((route) => [routeKey(route), { ...route }]))
  const newest = mergeProviderHealthSnapshots(
    quality.flatMap((route) => (route.providerHealth ? [{ ...route, providerHealth: route.providerHealth }] : [])),
    health,
  )
  for (const route of newest) {
    const key = routeKey(route)
    merged.set(key, {
      ...(merged.get(key) ?? {
        actorType: route.actorType,
        ...(route.model ? { model: route.model } : {}),
        samples: 0,
        successes: 0,
        totalCostUsd: null,
        successfulDeliverableCostUsd: null,
      }),
      providerHealth: { ...route.providerHealth },
    })
  }
  return [...merged.values()]
}
