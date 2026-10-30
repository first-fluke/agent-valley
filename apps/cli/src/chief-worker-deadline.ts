import { pendingCodeDelivery } from "@agent-valley/core/chief/code-delivery-contract"
import { MissionPause } from "@agent-valley/core/chief/execution"
import type { MissionStore } from "@agent-valley/core/chief/store"
import { WorkerTerminationError } from "./chief-worker-lifecycle"

type Worker = (args: string[], root: string, signal: AbortSignal) => Promise<number | null>

/** Pin the first persisted execution deadline across every worker restart in this supervisor. */
export function createDeadlineWorkerRunner(store: MissionStore, id: string, parentSignal: AbortSignal) {
  let deadline: number | undefined
  return async (worker: Worker, args: string[], root: string): Promise<number | null> => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let failure: unknown
    let finished = false
    const interrupt = () => controller.abort(parentSignal.reason)
    const stop = (error: unknown) => {
      failure = error
      controller.abort(error)
    }
    const expire = () =>
      stop(
        new MissionPause(
          "Mission time limit reached while awaiting its worker. The original deadline, work and spent usage were retained.",
          "budget",
        ),
      )
    const observe = async () => {
      if (finished || controller.signal.aborted) return
      if (deadline === undefined) {
        const mission = await store.load(id).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (finished || controller.signal.aborted) return
        // Reporting an already terminal outcome still goes through normal worker option validation.
        if (mission?.status === "completed" && !pendingCodeDelivery(mission)) return
        if (mission?.executionPolicy && mission.execution) {
          deadline = Date.parse(mission.execution.startedAt) + mission.executionPolicy.maxDurationSec * 1_000
          if (!Number.isFinite(deadline))
            throw new MissionPause(
              "Restore the original saved Mission execution deadline before resuming.",
              "integrity",
            )
        }
      }
      if (deadline === undefined) {
        // A new Mission has no execution clock until the child first persists one.
        timer = setTimeout(() => void observe().catch(stop), 100)
      } else if (deadline <= Date.now()) expire()
      else timer = setTimeout(expire, Math.min(deadline - Date.now(), 2_147_483_647))
    }
    parentSignal.addEventListener("abort", interrupt, { once: true })
    if (parentSignal.aborted) interrupt()
    try {
      await observe()
      if (failure) throw failure
      if (controller.signal.aborted) return null
      let result: number | null
      try {
        result = await worker(args, root, controller.signal)
      } catch (error) {
        if (error instanceof WorkerTerminationError) {
          if (failure instanceof Error)
            throw new WorkerTerminationError(`${failure.message} ${error.message}`, { cause: error })
          throw error
        }
        if (failure instanceof MissionPause)
          throw new MissionPause(`${failure.message} Worker exit error: ${String(error).slice(0, 1_000)}`, failure.kind)
        throw failure ?? error
      }
      if (failure) throw failure
      return result
    } finally {
      finished = true
      clearTimeout(timer)
      parentSignal.removeEventListener("abort", interrupt)
    }
  }
}
