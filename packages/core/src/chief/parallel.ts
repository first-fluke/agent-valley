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

/** Starts every child before waiting, preserves input order, and joins on abort. */
export async function runJoinedWave<T, R>(
  items: readonly T[],
  run: (item: T, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  signal?.throwIfAborted()
  const children = items.map(() => new AbortController())
  const abort = () => {
    for (const child of children) child.abort(signal?.reason)
  }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    if (signal?.aborted) abort()
    return await Promise.allSettled(
      items.map((item, index) => {
        const child = children[index]
        if (!child) throw new Error("Restore the parallel Actor wave before continuing.")
        return Promise.resolve().then(() => {
          child.signal.throwIfAborted()
          return run(item, child.signal)
        })
      }),
    )
  } finally {
    signal?.removeEventListener("abort", abort)
  }
}
