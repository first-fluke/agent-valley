/**
 * StateDatabase — the single SQLite file under `.agent-valley/` holding the
 * orchestrator's durable state: webhook replay keys, active attempts, the
 * retry queue, pending finalizations, the DAG cache and budget usage.
 *
 * One file replaces the per-concern JSON snapshots. Every store writes
 * through a transaction, so a crash leaves a complete record, and the
 * host closes the database after the orchestrator has flushed.
 *
 * libsql is already a dependency (team ledger); a `file:` URL uses its
 * embedded SQLite. Schema statements are idempotent, so upgrades only add.
 */

import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { type Client, createClient, type InStatement, type ResultSet } from "@libsql/client"
import { logger } from "../observability/logger"

export const STATE_DATABASE_FILE = "state.db"

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS webhook_deliveries (key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS webhook_deliveries_expires_at ON webhook_deliveries (expires_at)",
  `CREATE TABLE IF NOT EXISTS active_attempts (
    issue_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
    pid INTEGER, started_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS retry_queue (
    issue_id TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL, next_retry_at TEXT NOT NULL,
    last_error TEXT NOT NULL, category TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS dead_letter_queue (
    issue_id TEXT PRIMARY KEY, attempt_count INTEGER NOT NULL, failed_at TEXT NOT NULL,
    last_error TEXT NOT NULL, category TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS pending_finalizations (issue_id TEXT PRIMARY KEY, record TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS dag_nodes (
    issue_id TEXT PRIMARY KEY, identifier TEXT NOT NULL, status TEXT NOT NULL, parent_id TEXT,
    children TEXT NOT NULL, blocked_by TEXT NOT NULL, blocks TEXT NOT NULL)`,
  "CREATE TABLE IF NOT EXISTS budget_day_usage (day_key TEXT PRIMARY KEY, tokens REAL NOT NULL, usd REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS budget_issue_usage (issue_id TEXT PRIMARY KEY, tokens REAL NOT NULL, usd REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS budget_recorded_attempts (attempt_id TEXT PRIMARY KEY)",
]

export class StateDatabase {
  /** Resolves once the schema exists; every query awaits it. */
  readonly ready: Promise<void>
  private readonly inFlight = new Set<Promise<unknown>>()
  private closed = false

  constructor(readonly client: Client) {
    this.ready = this.ensureSchema()
    // Stores surface failures where they query; a rejected `ready` must
    // not become an unhandled rejection in the meantime.
    this.ready.catch(() => {})
  }

  /** Open the database file, creating it and its directory when missing. */
  static open(path: string): StateDatabase {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    return new StateDatabase(createClient({ url: `file:${path}`, intMode: "number" }))
  }

  /** Private in-memory database for tests. */
  static inMemory(): StateDatabase {
    return new StateDatabase(createClient({ url: "file::memory:", intMode: "number" }))
  }

  execute(statement: InStatement): Promise<ResultSet> {
    return this.track(this.ready.then(() => this.client.execute(statement)))
  }

  /** Run statements in one write transaction: all or none. */
  write(statements: InStatement[]): Promise<void> {
    if (statements.length === 0) return this.ready
    return this.track(this.ready.then(() => this.client.batch(statements, "write"))).then(() => undefined)
  }

  async getMeta(key: string): Promise<string | null> {
    const result = await this.execute({ sql: "SELECT value FROM schema_meta WHERE key = ?", args: [key] })
    const value = result.rows[0]?.value
    return typeof value === "string" ? value : null
  }

  setMetaStatement(key: string, value: string): InStatement {
    return {
      sql: "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      args: [key, value],
    }
  }

  /** Resolve once every query issued so far has settled. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  /** Wait for queries already issued, then release the file. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.idle()
    this.client.close()
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    return operation.finally(() => this.inFlight.delete(operation))
  }

  private async ensureSchema(): Promise<void> {
    try {
      await this.client.execute("PRAGMA journal_mode = WAL")
      await this.client.batch(
        [...SCHEMA.map((sql) => ({ sql, args: [] })), this.setMetaStatement("schema_version", "1")],
        "write",
      )
    } catch (err) {
      logger.error("state", "State database schema setup failed", { error: String(err) })
      throw err
    }
  }
}
