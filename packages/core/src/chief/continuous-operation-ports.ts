import type { ContainerObservationSnapshot } from "./container-observation-policy"
import type { ContinuousBaseline, ContinuousDecision, Operation } from "./continuous-contract"
import type { SourceIntegrationSummary } from "./source-integration-contract"
import type { Mission } from "./types"

export interface ContinuousOperationPorts {
  /** One operator-authorized selection attempt; saved automatic attempt counts are retained. */
  retryDecision?: boolean
  decide(operation: Operation, decisionId: string): Promise<ContinuousDecision>
  findMission(id: string): Promise<Mission | undefined>
  runMission(operation: Operation, id: string, goal: string, baselinePath: string): Promise<Mission>
  accept(operation: Operation, mission?: Mission): Promise<ContinuousBaseline>
  integrateSource?(
    operation: Operation,
    previous: ContinuousBaseline,
    next: ContinuousBaseline,
  ): Promise<SourceIntegrationSummary>
  save(operation: Operation): Promise<void>
  delay(milliseconds: number, signal?: AbortSignal): Promise<void>
  observeContainers?(operation: Operation): Promise<ContainerObservationSnapshot>
  now?: () => Date
  signal?: AbortSignal
}
