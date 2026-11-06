import { type ActorRoute, actorRouteHealth } from "./actor-health"
import { MissionPause } from "./execution"
import type { Mission, Persona } from "./types"

export class ActorCooldown extends MissionPause {
  constructor(
    message: string,
    nextRunAt: string | undefined,
    readonly routes: ActorRoute[],
  ) {
    super(message, "actor-cooldown", nextRunAt)
  }
}

/** Admission uses saved native health across tasks, stages, replans and child missions. */
export function availableActorRoutes<T extends ActorRoute>(mission: Mission, candidates: T[]): T[] {
  const inspected = candidates.map((route) => ({ route, health: actorRouteHealth(mission, route) }))
  const uncertain = inspected.find((entry) => entry.health.state === "unknown")
  if (uncertain) throw new MissionPause(uncertain.health.reason, "unknown-effect")
  const ready = inspected.filter((entry) => entry.health.state === "ready").map((entry) => entry.route)
  if (ready.length || !candidates.length) return ready
  const next = inspected
    .flatMap(({ health }) => (health.retryAt ? [health.retryAt] : []))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0]
  throw new ActorCooldown(
    `All eligible Actor routes are cooling down or already probing. ${inspected.map(({ route, health }) => `${route.actorType}/${route.model ?? "native default"}: ${health.reason}`).join(" ")} The saved work and spent limits are retained.`,
    next,
    candidates.map(({ actorType, model }) => ({ actorType, model })),
  )
}

/** Other joined work may already have completed the probe which produced this earlier wait. */
export function refreshActorCooldown(mission: Mission, error: unknown): unknown | undefined {
  if (!(error instanceof ActorCooldown)) return error
  try {
    availableActorRoutes(mission, error.routes)
    return undefined
  } catch (current) {
    return current
  }
}

export function assertActorAvailable(mission: Mission, actor: Persona, stage: string): void {
  if (!["work", "review", "gate-review", "final-review"].includes(stage)) return
  availableActorRoutes(mission, [{ actorType: actor.agentType, model: actor.model }])
}
