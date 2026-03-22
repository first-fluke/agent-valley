/**
 * SupabaseLedgerClient — publishes ledger events to Supabase PostgreSQL.
 * Implements LedgerEventPublisher with at-least-once delivery.
 *
 * Uses user's access token (not anon key) for Authorization header
 * so RLS policies (auth.uid()) work correctly.
 */

import type { LedgerEvent, LedgerEventPublisher } from "../domain/ledger"
import { logger } from "../observability/logger"

interface PendingEvent {
  event: Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">
  retries: number
}

export class SupabaseLedgerClient implements LedgerEventPublisher {
  private pendingQueue: PendingEvent[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private supabaseUrl: string,
    private supabaseAnonKey: string,
    private accessToken: string,
    private nodeId: string,
    private teamId: string,
    private userId: string,
  ) {
    this.flushTimer = setInterval(() => {
      this.flushQueue().catch((err) => {
        logger.error("supabase-ledger", "Unexpected flushQueue error", { error: String(err) })
      })
    }, 10_000)
  }

  async publish(event: Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">): Promise<void> {
    try {
      await this.insertEvent(event)
    } catch (err) {
      logger.warn("supabase-ledger", `Queuing event for retry: ${event.type}`, { error: String(err) })
      this.pendingQueue.push({ event, retries: 0 })
    }
  }

  private async insertEvent(event: Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">): Promise<void> {
    const res = await fetch(`${this.supabaseUrl}/rest/v1/ledger_events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: this.supabaseAnonKey,
        Authorization: `Bearer ${this.accessToken}`,
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        team_id: this.teamId,
        node_id: this.nodeId,
        user_id: this.userId,
        type: event.type,
        payload: event.payload,
        client_timestamp: event.clientTimestamp,
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`Supabase insert failed: ${res.status} ${body}`)
    }
  }

  private async flushQueue(): Promise<void> {
    if (this.pendingQueue.length === 0) return

    const batch = [...this.pendingQueue]
    this.pendingQueue = []

    for (const item of batch) {
      try {
        await this.insertEvent(item.event)
      } catch (err) {
        item.retries++
        if (item.retries < 5) {
          this.pendingQueue.push(item)
        } else {
          logger.error("supabase-ledger", `Dropping event after 5 retries: ${item.event.type}`, { error: String(err) })
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer)
    await this.flushQueue()
  }
}
