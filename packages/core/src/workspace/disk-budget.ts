import * as fs from "node:fs/promises"

const GIB = 1024 ** 3
export const DEFAULT_MIN_FREE_DISK_GIB = 5
export const MIN_FREE_DISK_ENV = "AV_MIN_FREE_DISK_GIB"

/** Free space AV must leave before creating another clone. `AV_MIN_FREE_DISK_GIB=0` disables the guard. */
export function minimumFreeDiskBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MIN_FREE_DISK_ENV]?.trim()
  if (!raw) return DEFAULT_MIN_FREE_DISK_GIB * GIB
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      `${MIN_FREE_DISK_ENV}=${raw} is invalid. Set it to a non-negative number of GiB (for example ${DEFAULT_MIN_FREE_DISK_GIB}), or 0 to disable the free-disk guard.`,
    )
  return value * GIB
}

/** Available bytes for unprivileged writes on the volume holding `path`; undefined when the runtime cannot tell. */
export async function freeDiskBytes(path: string): Promise<number | undefined> {
  const statfs = (fs as { statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> })
    .statfs
  if (typeof statfs !== "function") return undefined
  try {
    const stats = await statfs(path)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return undefined
  }
}

export class DiskBudgetExceeded extends Error {}

/**
 * Refuse to create another clone when the volume is nearly full. When `reclaim` is given it runs once
 * before the final check so AV can first release its own disposable storage.
 */
export async function ensureDiskBudget(
  path: string,
  purpose: string,
  reclaim?: () => Promise<unknown>,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const minimum = minimumFreeDiskBytes(env)
  if (minimum === 0) return
  let free = await freeDiskBytes(path)
  if (free === undefined || free >= minimum) return
  if (reclaim) {
    await reclaim().catch(() => undefined)
    free = await freeDiskBytes(path)
    if (free === undefined || free >= minimum) return
  }
  const gib = (bytes: number) => (bytes / GIB).toFixed(1)
  throw new DiskBudgetExceeded(
    `Only ${gib(free)} GiB is free on the volume holding ${path}; AV keeps at least ${gib(minimum)} GiB free before creating ${purpose}. Run \`av gc --apply\` in the repository to release completed mission storage, free disk space, or lower ${MIN_FREE_DISK_ENV} (0 disables this guard).`,
  )
}
