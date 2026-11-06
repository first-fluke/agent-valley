import type { Mission } from "./types"

function hasSchedule(mission: Mission): boolean {
  return mission.status === "waiting" && Number.isFinite(Date.parse(mission.execution?.nextRunAt ?? ""))
}

export function scheduledChiefWait(mission: Mission): boolean {
  return (
    hasSchedule(mission) &&
    mission.execution?.failureKind === "chief-wait" &&
    mission.supervision?.decisions.at(-1)?.action === "wait"
  )
}

export function scheduledActorCooldown(mission: Mission): boolean {
  return hasSchedule(mission) && mission.execution?.failureKind === "actor-cooldown"
}

export function scheduledMissionWait(mission: Mission): boolean {
  return scheduledChiefWait(mission) || scheduledActorCooldown(mission)
}
