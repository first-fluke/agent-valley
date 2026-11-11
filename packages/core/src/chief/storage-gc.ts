import { lstat, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import { archiveContinuousChild } from "./continuous-archive"
import { processEvidence, pruneContinuousBaselines } from "./continuous-retention"
import { ContinuousOperationStore } from "./continuous-store"
import { readContinuousMissionWorkspace, releaseContinuousBuildOutputs } from "./continuous-workspace"
import { releaseAppliedTaskWorktrees } from "./parallel-workspace"
import { MissionStore } from "./store"
import type { Mission } from "./types"

/** Idle failed/paused missions and finished operation children keep their full clones this long. */
export const DEFAULT_STORAGE_STALE_DAYS = 7
const DAY_MS = 86_400_000

export type StorageGcKind = "actor-workspace" | "build-output" | "child-archive" | "baseline"
export interface StorageGcEntry {
  kind: StorageGcKind
  path: string
  outcome: "released" | "eligible" | "kept"
  reason: string
  missionId?: string
  operationId?: string
}
export interface StorageGcOptions {
  /** Remove eligible storage. Default false: report only. */
  apply?: boolean
  staleDays?: number
  now?: () => Date
}

interface SavedMission {
  mission: Mission
  active: boolean
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  )
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

async function savedMissions(root: string, operationIds: string[]): Promise<Map<string, SavedMission>> {
  const directories = [
    join(root, ".agent-valley", "missions"),
    ...operationIds.map((id) => join(root, ".agent-valley", "operation-decisions", id)),
  ]
  const saved = new Map<string, SavedMission>()
  for (const directory of directories) {
    const store = new MissionStore(directory)
    for (const name of (await readdir(directory).catch(() => [] as string[])).sort()) {
      if (!name.endsWith(".json")) continue
      const id = name.slice(0, -5)
      try {
        const mission = await store.observe(id)
        saved.set(id, { mission, active: await processEvidence(directory, id) })
      } catch {
        // An unreadable or newer-format record keeps all of its storage.
      }
    }
  }
  return saved
}

/**
 * Release storage AV created and no longer needs, without touching the operator's checkout:
 * - applied Actor repositories of completed missions, or of failed/paused/interrupted missions idle for `staleDays`
 *   (Actor repositories still referenced by an unfinished task, unapplied, or unrecorded are always kept);
 * - ignored build output in AV-owned operation child workspaces under the same rule;
 * - finished operation children idle for `staleDays`, archived into the operation's `archive.git`;
 * - obsolete accepted baselines that the existing baseline pruning proves recoverable.
 * Missions with a lock or active process, and an operation's current/decision/recent children, are never touched.
 */
export async function collectStorageGarbage(
  repositoryRoot: string,
  options: StorageGcOptions = {},
): Promise<{ applied: boolean; entries: StorageGcEntry[] }> {
  const root = await realpath(repositoryRoot)
  const apply = options.apply === true
  const staleDays = options.staleDays ?? DEFAULT_STORAGE_STALE_DAYS
  if (!Number.isFinite(staleDays) || staleDays < 0)
    throw new Error(`staleDays=${staleDays} is invalid. Use a non-negative number of days (default 7).`)
  const now = (options.now ?? (() => new Date()))().getTime()
  const idleDays = (mission: Mission) => (now - Date.parse(mission.updatedAt)) / DAY_MS
  const outcome = apply ? "released" : "eligible"
  const entries: StorageGcEntry[] = []
  const operations = await new ContinuousOperationStore(join(root, ".agent-valley", "operations"))
    .list()
    .catch(() => [])
  const missions = await savedMissions(
    root,
    operations.map((operation) => operation.id),
  )

  for (const [missionId, { mission, active }] of missions) {
    const completed = mission.status === "completed"
    if (active || (!completed && idleDays(mission) < staleDays)) continue
    if (!(await exists(mission.workspace.path))) continue
    const why = completed
      ? "completed mission"
      : `${mission.status} mission idle for ${Math.floor(idleDays(mission))} days`
    const keep = new Set(completed ? [] : mission.tasks.flatMap((task) => (task.parallel ? [task.parallel.path] : [])))
    try {
      const actors = await releaseAppliedTaskWorktrees(mission, { keep, apply })
      for (const path of actors.released)
        entries.push({
          kind: "actor-workspace",
          missionId,
          path,
          outcome,
          reason: `Applied Actor repository of a ${why}; its patch receipt and evidence refs remain.`,
        })
    } catch (error) {
      entries.push({
        kind: "actor-workspace",
        missionId,
        path: mission.workspace.path,
        outcome: "kept",
        reason: message(error),
      })
    }
    try {
      const removed = await releaseContinuousBuildOutputs(mission.workspace.path, { apply })
      for (const relative of removed || [])
        entries.push({
          kind: "build-output",
          missionId,
          path: join(mission.workspace.path, relative),
          outcome,
          reason: `Ignored build output in the AV-owned workspace of a ${why}.`,
        })
    } catch (error) {
      entries.push({
        kind: "build-output",
        missionId,
        path: mission.workspace.path,
        outcome: "kept",
        reason: message(error),
      })
    }
  }

  for (const operation of operations) {
    const protectedIds = new Set(
      [
        operation.currentMissionId,
        operation.decisionId,
        operation.sourceIntegration?.missionId,
        ...operation.history.slice(-2).map((entry) => entry.missionId),
      ].filter((id): id is string => Boolean(id)),
    )
    const workspaces = join(root, ".agent-valley", "operations", operation.id, "workspaces")
    for (const missionId of (await readdir(workspaces).catch(() => [] as string[])).sort()) {
      const container = join(workspaces, missionId)
      const record = await readContinuousMissionWorkspace(container)
      if (!record || !(await exists(record.path)) || protectedIds.has(missionId)) continue
      const saved = missions.get(missionId)
      if (!saved || saved.active || !["completed", "failed"].includes(saved.mission.status)) continue
      if (idleDays(saved.mission) < staleDays) continue
      try {
        const result = await archiveContinuousChild(container, { apply, now: options.now })
        entries.push({
          kind: "child-archive",
          operationId: operation.id,
          missionId,
          path: record.path,
          outcome,
          reason: `${saved.mission.status} child idle for ${Math.floor(idleDays(saved.mission))} days; branches, evidence refs and product commit go to ${result.repository}, receipts to ${join(container, "archive")}.`,
        })
      } catch (error) {
        entries.push({
          kind: "child-archive",
          operationId: operation.id,
          missionId,
          path: record.path,
          outcome: "kept",
          reason: message(error),
        })
      }
    }
    if (!operation.baseline) continue
    try {
      const pruned = await pruneContinuousBaselines(root, operation.id, { apply, now: options.now })
      for (const candidate of pruned.candidates) {
        if (candidate.status === "kept" || candidate.reason.startsWith("Previously pruned")) continue
        entries.push({
          kind: "baseline",
          operationId: operation.id,
          path: candidate.path,
          outcome: candidate.status === "pruned" ? "released" : "eligible",
          reason: candidate.reason,
        })
      }
    } catch (error) {
      entries.push({
        kind: "baseline",
        operationId: operation.id,
        path: join(root, ".agent-valley", "operations", operation.id, "baselines"),
        outcome: "kept",
        reason: message(error),
      })
    }
  }
  return { applied: apply, entries }
}
