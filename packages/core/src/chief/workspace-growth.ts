import { execFile } from "node:child_process"

const GIB = 1024 ** 3
export const INTEGRATION_CHECK_GROWTH_ENV = "AV_INTEGRATION_CHECK_GROWTH_GIB"
export const DEFAULT_INTEGRATION_CHECK_GROWTH_GIB = 1
export const STORAGE_NOTE_PREFIX = "Storage:"

/** Growth one check may leave behind before AV reports it. `AV_INTEGRATION_CHECK_GROWTH_GIB=0` disables the report. */
export function growthThresholdBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = env[INTEGRATION_CHECK_GROWTH_ENV]?.trim()
  if (!raw) return DEFAULT_INTEGRATION_CHECK_GROWTH_GIB * GIB
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0)
    throw new Error(
      `${INTEGRATION_CHECK_GROWTH_ENV}=${raw} is invalid. Set it to a non-negative number of GiB (for example ${DEFAULT_INTEGRATION_CHECK_GROWTH_GIB}), or 0 to disable the storage report.`,
    )
  return value * GIB
}

/**
 * Bytes used by each directory of `path` down to three levels, keyed by its relative path ("" is the root).
 * Undefined where `du` is missing, fails or takes longer than the bound: the report is then skipped.
 */
export function directorySizes(path: string, timeoutMs = 60_000): Promise<Map<string, number> | undefined> {
  return new Promise((resolve) => {
    execFile("du", ["-k", "-d", "3", path], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      // du exits nonzero when one entry is unreadable; its other lines are still valid.
      if (error && !stdout) return resolve(undefined)
      const sizes = new Map<string, number>()
      for (const line of stdout.split("\n")) {
        const tab = line.indexOf("\t")
        const kib = Number(line.slice(0, tab))
        if (tab < 1 || !Number.isFinite(kib)) continue
        const entry = line.slice(tab + 1)
        if (entry !== path && !entry.startsWith(`${path}/`)) continue
        sizes.set(entry.slice(path.length + 1), kib * 1024)
      }
      resolve(sizes.has("") ? sizes : undefined)
    })
  })
}

const owned = (entry: string) =>
  [".git", ".agent-valley"].some((root) => entry === root || entry.startsWith(`${root}/`))

/**
 * A check that leaves build or fixture output behind used to fill the disk unnoticed: one project's test run
 * left 2.6 GiB per execution and a day of checks added 48 GiB. The observed growth is handed to the reviewers
 * of the delivery with the directories it went to, so the delivery that leaks is repaired like any other defect.
 */
export function growthReport(
  before: ReadonlyMap<string, number> | undefined,
  after: ReadonlyMap<string, number> | undefined,
  thresholdBytes: number,
): string | undefined {
  if (!before || !after || thresholdBytes <= 0) return undefined
  const delta = (entry: string) => (after.get(entry) ?? 0) - (before.get(entry) ?? 0)
  // AV's own clones and Git objects are not the project's output.
  const total = delta("") - [".git", ".agent-valley"].reduce((sum, root) => sum + delta(root), 0)
  if (total < thresholdBytes) return undefined
  const floor = Math.max(total / 10, 64 * 1024 ** 2)
  const depth = (entry: string) => entry.split("/").length
  const grown = [...after.keys()]
    .filter((entry) => entry && !owned(entry) && delta(entry) >= floor)
    .sort((a, b) => depth(b) - depth(a) || delta(b) - delta(a))
  const picked: string[] = []
  for (const entry of grown) if (!picked.some((child) => child.startsWith(`${entry}/`))) picked.push(entry)
  const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`
  const where = picked
    .sort((a, b) => delta(b) - delta(a))
    .slice(0, 3)
    .map((entry) => `${entry} (+${gib(delta(entry))})`)
  const size = (after.get("") ?? 0) - (after.get(".git") ?? 0) - (after.get(".agent-valley") ?? 0)
  return `${STORAGE_NOTE_PREFIX} this check left ${gib(total)} of new files in the workspace (${gib(size)} in total)${
    where.length ? `, mostly under ${where.join(", ")}` : ""
  }. Nothing removes them, so repeated checks fill the disk; the tests or scripts that create these files have to remove them.`
}
