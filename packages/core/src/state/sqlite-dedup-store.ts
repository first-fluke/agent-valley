/**
 * SqliteDedupStore — durable backing for WebhookDedupCache. Delivery keys
 * survive a restart, so a tracker redelivery during the TTL window is
 * still rejected after the process comes back.
 */

import { logger } from "../observability/logger"
import type { DedupKeyStore } from "../tracker/dedup-cache"
import type { StateDatabase } from "./state-database"

export class SqliteDedupStore implements DedupKeyStore {
  constructor(private readonly db: StateDatabase) {}

  async loadLive(now: number): Promise<Array<{ key: string; expiresAt: number }>> {
    const result = await this.db.execute({
      sql: "SELECT key, expires_at FROM webhook_deliveries WHERE expires_at > ? ORDER BY expires_at",
      args: [now],
    })
    return result.rows.map((row) => ({ key: String(row.key), expiresAt: Number(row.expires_at) }))
  }

  record(key: string, expiresAt: number): void {
    this.db
      .write([
        {
          sql: "INSERT INTO webhook_deliveries (key, expires_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at",
          args: [key, expiresAt],
        },
      ])
      .catch((err) => {
        logger.warn("state", "Failed to record webhook delivery key", { error: String(err) })
      })
  }

  purgeExpired(now: number): void {
    this.db.write([{ sql: "DELETE FROM webhook_deliveries WHERE expires_at <= ?", args: [now] }]).catch((err) => {
      logger.warn("state", "Failed to purge expired webhook delivery keys", { error: String(err) })
    })
  }
}
