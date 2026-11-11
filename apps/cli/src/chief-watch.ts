import { join } from "node:path"
import { pendingCodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import { automaticMissionRecovery, verifiedMissionEvidence } from "@agent-valley/core/chief/continuous-recovery"
import { serviceShutdownPause } from "@agent-valley/core/chief/service-shutdown"
import { MissionStore } from "@agent-valley/core/chief/store"
import { operationStore, runOperation } from "./chief-continuous"
import { reobserveLocalExecutions } from "./chief-local-recovery"
import { printOrderOutcome } from "./chief-outcome"
import { abortableDelay, superviseOrder } from "./chief-supervisor"
import { assertNotManagedRun } from "./managed-run"

interface WatchDependencies {
  service?: boolean
  signal?: AbortSignal
  delay?: typeof abortableDelay
  mission?: typeof superviseOrder
  operation?: typeof runOperation
  /** Periodic storage release; the CLI wires collectStorageGarbage, tests leave it unset. */
  storageGc?: (root: string, options: { apply: boolean }) => Promise<{ entries: { outcome: string }[] }>
  storageGcIntervalMs?: number
  now?: () => number
}

/** Release idle AV storage at most once per interval while the watcher runs. */
export const STORAGE_GC_INTERVAL_MS = 60 * 60 * 1000

export async function watchOrders(root = process.cwd(), dependencies: WatchDependencies = {}): Promise<void> {
  assertNotManagedRun()
  const controller = new AbortController()
  const stop = () => controller.abort(dependencies.signal?.reason)
  const terminate = () => controller.abort(dependencies.service ? serviceShutdownPause() : undefined)
  dependencies.signal?.addEventListener("abort", stop, { once: true })
  if (dependencies.signal?.aborted) stop()
  if (!dependencies.signal) {
    process.once("SIGINT", stop)
    process.once("SIGTERM", terminate)
  }
  const missions = new MissionStore(join(root, ".agent-valley", "missions"))
  const now = dependencies.now ?? Date.now
  let lastStorageGc = Number.NEGATIVE_INFINITY
  try {
    while (!controller.signal.aborted) {
      if (
        dependencies.storageGc &&
        now() - lastStorageGc >= (dependencies.storageGcIntervalMs ?? STORAGE_GC_INTERVAL_MS)
      ) {
        lastStorageGc = now()
        try {
          const { entries } = await dependencies.storageGc(root, { apply: true })
          const released = entries.filter((entry) => entry.outcome === "released").length
          const kept = entries.filter((entry) => entry.outcome === "kept").length
          if (released || kept) console.log(`Storage GC: ${released} released, ${kept} kept. Run av gc for details.`)
        } catch (error) {
          console.error(`Storage GC failed: ${String(error)}. Run av gc to inspect.`)
        }
      }
      const operations = await operationStore(root).list()
      const childIds = new Set(
        operations.flatMap((operation) => (operation.currentMissionId ? [operation.currentMissionId] : [])),
      )
      for (const saved of await missions.list()) {
        if (controller.signal.aborted) break
        if (childIds.has(saved.id) || !saved.executionPolicy?.autoResume) continue
        if (await missions.isLocked(saved.id)) continue
        try {
          const mission = await reobserveLocalExecutions(saved, missions)
          if (mission.status === "completed") {
            if (
              !pendingCodeDelivery(mission) ||
              (mission.codeDelivery?.nextRunAt && Date.parse(mission.codeDelivery.nextRunAt) > Date.now())
            )
              continue
            await (dependencies.mission ?? superviseOrder)(
              undefined,
              { resume: mission.id, ...(dependencies.service ? { service: true } : {}) },
              root,
              {
                signal: controller.signal,
              },
            ).then(printOrderOutcome)
            continue
          }
          const recovery = automaticMissionRecovery(mission)
          if (!recovery.retry || (recovery.waitUntil && Date.parse(recovery.waitUntil) > Date.now())) continue
          await (dependencies.mission ?? superviseOrder)(
            undefined,
            { resume: mission.id, ...(dependencies.service ? { service: true } : {}) },
            root,
            {
              signal: controller.signal,
            },
          ).then(printOrderOutcome)
        } catch (error) {
          console.error(String(error))
        }
      }
      for (const operation of operations) {
        if (controller.signal.aborted) break
        if (operation.phase === "completed") continue
        if (operation.currentMissionId && (await missions.isLocked(operation.currentMissionId))) continue
        // Legacy and explicitly cancelled pauses remain operator-controlled.
        if (operation.phase === "paused") {
          if (
            operation.pauseKind !== "service-shutdown" &&
            (operation.pauseKind !== "blocked" || !operation.currentMissionId)
          )
            continue
          if (operation.currentMissionId) {
            try {
              const child = await reobserveLocalExecutions(await missions.load(operation.currentMissionId), missions)
              if (child.codeDelivery?.phase === "blocked") continue
              if (
                !automaticMissionRecovery(child).retry &&
                !(child.status === "completed" && verifiedMissionEvidence(child))
              )
                continue
            } catch (error) {
              console.error(String(error))
              continue
            }
          }
        }
        try {
          await (dependencies.operation ?? runOperation)(
            undefined,
            { resume: operation.id, ...(dependencies.service ? { service: true } : {}) },
            root,
            {
              signal: controller.signal,
            },
          )
        } catch (error) {
          console.error(String(error))
        }
      }
      await (dependencies.delay ?? abortableDelay)(5_000, controller.signal)
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error
  } finally {
    dependencies.signal?.removeEventListener("abort", stop)
    if (!dependencies.signal) {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", terminate)
    }
  }
}
