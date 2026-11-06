import { join } from "node:path"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import {
  assertSettledSourceIntegrations,
  integrateContinuousSource,
  prepareSourceIntegration,
} from "@agent-valley/core/chief/continuous-source-integration"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import { validateContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { assertNoUncertainExecution } from "@agent-valley/core/chief/execution"
import type { SourceIntegrationPolicy } from "@agent-valley/core/chief/source-integration-contract"
import { MissionStore } from "@agent-valley/core/chief/store"

export type SourceIntegrationMode = SourceIntegrationPolicy["mode"]

export function sourceIntegrationCheckpoint(operation: ContinuousOperation) {
  const accepted = operation.baseline
  const applied = operation.sourceIntegration
  const caughtUp =
    !accepted?.missionId || (applied?.missionId === accepted.missionId && applied.nextTree === accepted.baselineTree)
  const pendingIds = [operation.currentMissionId, ...(caughtUp ? [] : [accepted?.missionId])].filter(
    (id): id is string => !!id,
  )
  return { accepted, applied, caughtUp, pendingIds }
}

export function sourceIntegrationMode(value?: string): SourceIntegrationMode | undefined {
  if (value === undefined || value === "worktree" || value === "snapshot-only") return value
  throw new Error(
    "Set --source-integration to worktree or snapshot-only. Worktree mode applies verified source files without staging, committing or pushing them.",
  )
}

export async function initialSourceIntegration(
  repositoryRoot: string,
  id: string,
  mode?: string,
  remoteDelivery?: string,
): Promise<SourceIntegrationPolicy> {
  const selected = sourceIntegrationMode(mode) ?? (remoteDelivery ? "snapshot-only" : "worktree")
  if (selected === "worktree" && remoteDelivery)
    throw new Error(
      "Use either --source-integration worktree or --deliver for commit and push delivery. Omit worktree mode when enabling remote delivery.",
    )
  return selected === "snapshot-only" ? { mode: selected } : prepareSourceIntegration(repositoryRoot, id)
}

async function assertChildSettled(operation: ContinuousOperation, storageRoot: string): Promise<void> {
  if (!operation.currentMissionId) return
  const missions = new MissionStore(join(storageRoot, ".agent-valley", "missions"))
  if (await missions.isLocked(operation.currentMissionId))
    throw new Error(
      "The current child is still owned by another coordinator. Resume source integration after its checkpoint is settled.",
    )
  const child = await missions.load(operation.currentMissionId).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!child) return
  assertNoUncertainExecution(child)
  if (child.tasks.some((task) => task.effectState === "unknown" || task.effectState === "running"))
    throw new Error("Resolve the current child's external-effect outcome before enabling source integration.")
}

/** Save activation before source writes; ordinary resume finishes the same retained catch-up transaction. */
export async function resumeSourceIntegration(
  operation: ContinuousOperation,
  mode: string | undefined,
  storageRoot: string,
  signal?: AbortSignal,
  save?: (operation: ContinuousOperation) => Promise<void>,
): Promise<void> {
  const selected = sourceIntegrationMode(mode)
  if (selected === undefined && operation.sourceIntegrationPolicy?.mode !== "worktree") return
  if (operation.settings.deliver)
    if (selected !== "snapshot-only")
      throw new Error(
        "This operation already uses explicit commit and push delivery. Keep its saved delivery policy instead of adding worktree application.",
      )
  const persist =
    save ?? ((current) => new ContinuousOperationStore(join(storageRoot, ".agent-valley", "operations")).save(current))
  const { accepted, applied, caughtUp, pendingIds } = sourceIntegrationCheckpoint(operation)
  const activation = selected === "worktree" && operation.sourceIntegrationPolicy?.mode !== "worktree"
  if (activation) {
    await assertChildSettled(operation, storageRoot)
    signal?.throwIfAborted()
    operation.sourceIntegrationPolicy = await prepareSourceIntegration(operation.repositoryRoot, operation.id)
    operation.updatedAt = new Date().toISOString()
    await persist(operation)
  }
  try {
    signal?.throwIfAborted()
    if (selected === "snapshot-only") {
      await assertSettledSourceIntegrations(operation.repositoryRoot, operation.id, pendingIds)
      operation.sourceIntegrationPolicy = { mode: selected }
      operation.updatedAt = new Date().toISOString()
      await persist(operation)
      return
    }
    let policy = operation.sourceIntegrationPolicy
    if (policy?.mode === "worktree") {
      const current = await prepareSourceIntegration(operation.repositoryRoot, operation.id)
      if (current.branch !== policy.branch || current.head !== policy.head) {
        if (selected !== "worktree")
          throw new Error(
            "Source branch or HEAD moved from the saved integration target. Preserve local changes and explicitly reconcile source mode before resuming.",
          )
        await assertSettledSourceIntegrations(operation.repositoryRoot, operation.id, pendingIds)
        if (!caughtUp)
          throw new Error(
            "Source catch-up is still pending under the original target. Preserve local changes and reconcile that retained transaction before re-pinning worktree integration.",
          )
        await assertChildSettled(operation, storageRoot)
        operation.sourceIntegrationPolicy = current
        operation.updatedAt = new Date().toISOString()
        await persist(operation)
        policy = current
      }
    }
    if (
      policy?.mode === "worktree" &&
      accepted?.missionId &&
      (applied?.missionId !== accepted.missionId || applied.nextTree !== accepted.baselineTree)
    ) {
      if (applied?.missionId === accepted.missionId)
        throw new Error(
          "The saved source application summary differs from its accepted snapshot. Restore the original verified receipt before resuming.",
        )
      const previous = await validateContinuousBaseline(
        operation.repositoryRoot,
        operation.id,
        join(
          operation.repositoryRoot,
          ".agent-valley",
          "operations",
          operation.id,
          "baselines",
          applied?.missionId ?? "initial",
          "workspace",
        ),
      )
      if (applied && previous.baselineTree !== applied.nextTree)
        throw new Error(
          "The last applied source snapshot no longer matches its saved summary. Restore its original baseline before resuming.",
        )
      operation.sourceIntegration = await integrateContinuousSource(operation, previous, accepted, signal)
      operation.updatedAt = new Date().toISOString()
      await persist(operation)
    }
  } catch (error) {
    if (operation.phase !== "paused" && operation.phase !== "completed") operation.resumePhase = operation.phase
    operation.phase = "paused"
    operation.pauseKind = signal?.aborted ? "interrupted" : "blocked"
    operation.error = (error instanceof Error ? error.message : String(error)).slice(0, 16_000)
    operation.updatedAt = new Date().toISOString()
    await persist(operation)
    throw error
  }
}
