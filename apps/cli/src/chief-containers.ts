import {
  type ContainerObservationDependencies,
  collectContainerObservation,
} from "@agent-valley/core/chief/container-observation"
import type { Mission } from "@agent-valley/core/chief/types"

export function createMissionContainerPorts(dependencies: ContainerObservationDependencies = {}) {
  return {
    observeContainers(mission: Mission) {
      if (!mission.containerObservationPolicy)
        throw new Error("Restore the pinned container observation policy before collecting service evidence.")
      return collectContainerObservation(mission.containerObservationPolicy, mission.containerObservation, dependencies)
    },
  }
}
