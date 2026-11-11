import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  collectStorageGarbage,
  DEFAULT_STORAGE_STALE_DAYS,
  type StorageGcEntry,
} from "@agent-valley/core/chief/storage-gc"
import { freeDiskBytes } from "@agent-valley/core/workspace/disk-budget"
import type { Command } from "commander"
import { assertNotManagedRun } from "./managed-run"

const exec = promisify(execFile)
const GIB = 1024 ** 3
const gib = (bytes: number) => `${(bytes / GIB).toFixed(1)} GiB`

async function diskUsage(path: string): Promise<number | undefined> {
  try {
    const { stdout } = await exec("du", ["-sk", path])
    const kib = Number(stdout.trim().split(/\s+/)[0])
    return Number.isFinite(kib) ? kib * 1024 : undefined
  } catch {
    return undefined
  }
}

export function parseStaleDays(value: string | undefined): number {
  if (value === undefined) return DEFAULT_STORAGE_STALE_DAYS
  const days = Number(value)
  if (!Number.isFinite(days) || days < 0)
    throw new Error(
      `--stale-days ${value} is invalid. Use a non-negative number of days (default ${DEFAULT_STORAGE_STALE_DAYS}).`,
    )
  return days
}

export function summarizeStorageGc(entries: StorageGcEntry[]): string {
  const count = (outcome: StorageGcEntry["outcome"]) => entries.filter((entry) => entry.outcome === outcome).length
  return `${count("released")} released, ${count("eligible")} eligible, ${count("kept")} kept`
}

export async function runStorageGc(
  options: { apply?: boolean; staleDays?: string },
  root = process.cwd(),
  log: (line: string) => void = console.log,
): Promise<StorageGcEntry[]> {
  assertNotManagedRun()
  const staleDays = parseStaleDays(options.staleDays)
  const before = options.apply ? await freeDiskBytes(root) : undefined
  const result = await collectStorageGarbage(root, { apply: options.apply === true, staleDays })
  let total = 0
  for (const entry of result.entries) {
    const size = entry.outcome === "eligible" ? await diskUsage(entry.path) : undefined
    if (size) total += size
    log(
      `${entry.outcome.padEnd(8)}  ${entry.kind.padEnd(15)}  ${size ? gib(size).padStart(9) : "".padStart(9)}  ${entry.path}`,
    )
    log(`  ${entry.reason}`)
  }
  log(
    `Storage GC (${result.applied ? "apply" : "dry run"}, stale after ${staleDays} days): ${summarizeStorageGc(result.entries)}.`,
  )
  if (result.applied) {
    const after = await freeDiskBytes(root)
    if (before !== undefined && after !== undefined) log(`Free disk space: ${gib(before)} -> ${gib(after)}.`)
  } else {
    log(`About ${gib(total)} can be released. Nothing was removed; run av gc --apply to release it.`)
  }
  return result.entries
}

export function registerStorageGcCommand(program: Command): void {
  program
    .command("gc")
    .description(
      "Release disposable AV storage: applied Actor clones, build output, idle operation children, old baselines",
    )
    .option("--apply", "Remove eligible storage (default: report only)")
    .option(
      "--stale-days <days>",
      `Idle days before failed/paused missions and finished operation children are released (default ${DEFAULT_STORAGE_STALE_DAYS})`,
    )
    .action(async (options: { apply?: boolean; staleDays?: string }) => {
      await runStorageGc(options)
    })
}
