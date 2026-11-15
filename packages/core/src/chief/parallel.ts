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

/** Task counts of the dependency waves a plan can run in, in order; a cyclic remainder is left out. */
export function planWaveWidths(tasks: ReadonlyArray<Pick<ChiefTask, "id" | "dependencies">>): number[] {
  const completed = new Set<string>()
  const widths: number[] = []
  let remaining = [...tasks]
  while (remaining.length) {
    const ready = remaining.filter((task) => task.dependencies.every((id) => completed.has(id)))
    if (!ready.length) break
    for (const task of ready) completed.add(task.id)
    remaining = remaining.filter((task) => !completed.has(task.id))
    widths.push(ready.length)
  }
  return widths
}

/**
 * The other tasks of `id`'s dependency wave, and the later tasks that depend on any task of that wave.
 * Wave tasks run in separate workspaces and are merged afterwards, so a file two of them edit cannot merge.
 */
export function planWaveOf(
  tasks: ReadonlyArray<Pick<ChiefTask, "id" | "dependencies">>,
  id: string,
): { peers: string[]; dependents: string[] } {
  const completed = new Set<string>()
  let remaining = [...tasks]
  while (remaining.length) {
    const ready = remaining.filter((task) => task.dependencies.every((entry) => completed.has(entry)))
    if (!ready.length) break
    if (ready.some((task) => task.id === id)) {
      const wave = new Set(ready.map((task) => task.id))
      return {
        peers: [...wave].filter((entry) => entry !== id),
        dependents: tasks
          .filter((task) => !wave.has(task.id) && task.dependencies.some((entry) => wave.has(entry)))
          .map((task) => task.id),
      }
    }
    for (const task of ready) completed.add(task.id)
    remaining = remaining.filter((task) => !completed.has(task.id))
  }
  return { peers: [], dependents: [] }
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
