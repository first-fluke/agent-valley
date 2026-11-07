import type { ChiefPlan, ChiefTask, ChiefTaskState } from "./types"

/** A dependent task becomes ready only after its predecessors passed review. */
export function readyTaskWave(plan: ChiefPlan, states: ChiefTaskState[], limit: number): ChiefTask[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error("Use a parallel Actor limit between 1 and 20.")
  const completed = new Set(states.filter((state) => state.status === "completed").map((state) => state.id))
  return plan.tasks
    .filter((task) => !completed.has(task.id) && task.dependencies.every((id) => completed.has(id)))
    .slice(0, limit)
}

/** Starts up to `limit` children at once, preserves input order, and joins on abort. */
export async function runJoinedWave<T, R>(
  items: readonly T[],
  run: (item: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
  limit: number = Math.max(1, items.length),
): Promise<PromiseSettledResult<R>[]> {
  signal?.throwIfAborted()
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Use a positive integer parallel Actor limit.")
  const children = items.map(() => new AbortController())
  const abort = () => {
    for (const child of children) child.abort(signal?.reason)
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) abort()
    const results: PromiseSettledResult<R>[] = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const index = next++
        const child = children[index]
        const item = items[index]
        if (!child || item === undefined) throw new Error("Restore the parallel Actor wave before continuing.")
        try {
          child.signal.throwIfAborted()
          results[index] = { status: "fulfilled", value: await run(item, child.signal) }
        } catch (error) {
          results[index] = { status: "rejected", reason: error }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
    return results
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}
