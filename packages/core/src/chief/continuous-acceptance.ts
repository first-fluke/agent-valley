import { continuousBaselineSchema, type Operation } from "./continuous-contract"
import type { ContinuousOperationPorts } from "./continuous-operation-ports"
import { type SourceIntegrationSummary, sourceIntegrationSummarySchema } from "./source-integration-contract"
import type { Mission } from "./types"

/** Acceptance includes source application before a cycle can count or select its successor. */
export async function acceptContinuousChild(
  operation: Operation,
  mission: Mission,
  ports: Pick<ContinuousOperationPorts, "accept" | "integrateSource" | "signal">,
  save: () => Promise<void>,
  now: () => string,
): Promise<void> {
  const previous = operation.baseline
  const decision = operation.decision
  const id = operation.currentMissionId
  if (!previous || !id || decision?.action !== "execute")
    throw new Error("Restore the accepted baseline and child decision before accepting source changes.")
  operation.phase = "accepting"
  await save()
  const baseline = continuousBaselineSchema.parse(await ports.accept(operation, mission))
  if (
    baseline.operationId !== operation.id ||
    baseline.repositoryRoot !== operation.repositoryRoot ||
    baseline.missionId !== id
  )
    throw new Error(
      "Accepted snapshot identity does not match the completed child. Restore its snapshot receipt before continuing.",
    )
  ports.signal?.throwIfAborted()
  let integration: SourceIntegrationSummary | undefined
  const policy = operation.sourceIntegrationPolicy
  if (policy?.mode === "worktree" && mission.codeDelivery)
    throw new Error(
      "This child used explicit commit and push delivery while its parent still has worktree source application enabled. Reconcile the parent's delivery policy, or resume the parent with --source-integration snapshot-only; its verified child and spent limits are retained.",
    )
  if (policy?.mode === "worktree" && !mission.codeDelivery) {
    if (!ports.integrateSource)
      throw new Error(
        "Restore the source integration adapter before accepting this cycle; the verified child was retained.",
      )
    integration = sourceIntegrationSummarySchema.parse(await ports.integrateSource(operation, previous, baseline))
    if (
      integration.missionId !== id ||
      integration.branch !== policy.branch ||
      integration.sourceHead !== policy.head ||
      integration.previousTree !== previous.baselineTree ||
      integration.nextTree !== baseline.baselineTree
    )
      throw new Error(
        "Source application receipt belongs to a different child, branch or verified tree. Restore its original receipt before continuing.",
      )
    ports.signal?.throwIfAborted()
    operation.sourceIntegration = integration
  }
  operation.baseline = baseline
  operation.completedCycles += 1
  operation.history = [
    ...operation.history,
    {
      missionId: id,
      goal: decision.goal,
      reason: decision.reason,
      evidence: decision.evidence,
      completedAt: now(),
      baselinePath: baseline.path,
      ...(integration ? { sourceIntegration: integration } : {}),
    },
  ].slice(-20)
  operation.currentMissionId = undefined
  operation.decisionId = undefined
  operation.decision = undefined
  operation.decisionObservation = undefined
  operation.decisionObservationRevision = undefined
  operation.nextRunAt = undefined
  operation.recovery = undefined
  operation.phase = "deciding"
  await save()
}
