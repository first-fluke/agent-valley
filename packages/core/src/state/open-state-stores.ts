/**
 * openStateStores — the host's single entry point to durable state. Opens
 * `.agent-valley/state.db`, imports the JSON snapshots of earlier builds
 * on first use, and hands back every store the orchestrator, its
 * receivers and the budget service take by injection.
 */

import { join } from "node:path"
import type { BudgetUsagePort } from "../orchestrator/budget-persistence"
import type { DagCachePort } from "../orchestrator/persistence/dag-cache-store"
import type { RunStatePort } from "../orchestrator/persistence/run-state-store"
import { WebhookDedupCache } from "../tracker/dedup-cache"
import { SqliteBudgetUsageStore } from "./sqlite-budget-usage-store"
import { SqliteDagCacheStore } from "./sqlite-dag-cache-store"
import { SqliteDedupStore } from "./sqlite-dedup-store"
import { SqliteRunStateStore } from "./sqlite-run-state-store"
import { STATE_DATABASE_FILE, StateDatabase } from "./state-database"

export interface StateStores {
  database: StateDatabase
  runState: RunStatePort
  dagCache: DagCachePort
  budgetUsage: BudgetUsagePort
  /** Shared by every webhook receiver; keys of different trackers never collide. */
  dedupCache: WebhookDedupCache
  /** Wait for queued writes, then release the file. Call after the orchestrator stopped. */
  close(): Promise<void>
}

/** `stateDir` is the project's `.agent-valley` directory. */
export async function openStateStores(stateDir: string): Promise<StateStores> {
  const database = StateDatabase.open(join(stateDir, STATE_DATABASE_FILE))
  try {
    await database.ready
  } catch (err) {
    await database.close()
    throw new Error(
      `Agent Valley could not open its state database at ${join(stateDir, STATE_DATABASE_FILE)}: ${String(err)}\n` +
        "  Fix: check that the directory is writable and that @libsql/client installed its native binding.",
    )
  }
  const dedupCache = new WebhookDedupCache({ store: new SqliteDedupStore(database) })
  await dedupCache.hydrate()
  const runState = new SqliteRunStateStore(database, join(stateDir, "run-state.json"))
  const budgetUsage = new SqliteBudgetUsageStore(database, join(stateDir, "budget-usage.json"))
  return {
    database,
    runState,
    dagCache: new SqliteDagCacheStore(database, join(stateDir, "dag-cache.json")),
    budgetUsage,
    dedupCache,
    close: async () => {
      await Promise.all([runState.flush(), budgetUsage.flush()])
      await database.close()
    },
  }
}
