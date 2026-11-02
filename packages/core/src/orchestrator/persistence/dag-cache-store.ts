/**
 * DagCachePort — where DagScheduler keeps its node cache between runs.
 * The JSON file store is the default for bare cores and tests; the host
 * injects the SQLite store (`state/sqlite-dag-cache-store.ts`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { DagCache } from "../../domain/models"

export interface DagCachePort {
  /** Null when nothing was saved yet or the record is unreadable. */
  load(): Promise<DagCache | null>
  save(cache: DagCache): Promise<void>
}

export class JsonDagCacheStore implements DagCachePort {
  constructor(private readonly cachePath: string) {}

  async load(): Promise<DagCache | null> {
    try {
      return JSON.parse(await readFile(this.cachePath, "utf-8")) as DagCache
    } catch {
      return null
    }
  }

  async save(cache: DagCache): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true })
    await writeFile(this.cachePath, JSON.stringify(cache, null, 2), "utf-8")
  }
}
