import { assertExecutionDeadline, executionState, MissionPause } from "./execution"
import type { Mission } from "./types"

export async function withMissionDeadline<T>(
  mission: Mission,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (!mission.executionPolicy) return run(parent)
  assertExecutionDeadline(mission)
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener("abort", abort, { once: true })
  if (parent?.aborted) abort()
  const remaining =
    Date.parse(executionState(mission).startedAt) + mission.executionPolicy.maxDurationSec * 1_000 - Date.now()
  const timer = setTimeout(
    () =>
      controller.abort(
        new MissionPause("Mission wall-time limit reached. Increase --duration on resume to continue.", "budget"),
      ),
    Math.max(1, remaining),
  )
  timer.unref()
  try {
    const result = await run(controller.signal)
    if (controller.signal.aborted) throw controller.signal.reason
    return result
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener("abort", abort)
  }
}
