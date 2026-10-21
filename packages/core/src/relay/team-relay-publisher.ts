import { randomUUID } from "node:crypto"
import type { LedgerEvent, LedgerEventPublisher } from "../domain/ledger"
import { logger } from "../observability/logger"
import { type PublishableEvent, publishableEventSchema } from "./team-event-codec"
import type { TeamRelayClient } from "./team-relay-client"
import { TeamRelayError } from "./team-relay-error"

interface PendingEvent {
  event: PublishableEvent
  eventId: string
  retries: number
}

/** One ordered queue per publisher; failed heads retain their event ID across retries. */
export class TeamRelayPublisher implements LedgerEventPublisher {
  private readonly queue: PendingEvent[] = []
  private flushing: Promise<void> | undefined
  private readonly timer: ReturnType<typeof setInterval>
  private closed = false

  constructor(private readonly client: Pick<TeamRelayClient, "publish">) {
    this.timer = setInterval(() => void this.flush(), 10_000)
    this.timer.unref?.()
  }

  async publish(event: Omit<LedgerEvent, "seq" | "relayTimestamp" | "v">): Promise<void> {
    if (this.closed) throw new TeamRelayError("publisher_closed", "Team publisher is closed.", 503)
    const parsed = publishableEventSchema.safeParse(event)
    if (!parsed.success) throw new TeamRelayError("invalid_event", "Cannot publish an invalid ledger event.", 400)
    this.queue.push({ event: parsed.data, eventId: randomUUID(), retries: 0 })
    await this.flush()
  }

  private flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.drain().finally(() => {
      this.flushing = undefined
    })
    return this.flushing
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const pending = this.queue[0]
      if (!pending) return
      try {
        await this.client.publish(pending.event, pending.eventId)
        this.queue.shift()
      } catch (error) {
        pending.retries++
        const permanent =
          error instanceof TeamRelayError &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 429
        if (permanent || pending.retries >= 5) {
          this.queue.shift()
          logger.warn("team-relay", "Ledger event could not be delivered; bounded retry ended.", {
            type: pending.event.type,
          })
          continue
        }
        logger.warn("team-relay", "Ledger delivery is pending; later events remain behind it.", {
          type: pending.event.type,
        })
        return
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return
    this.closed = true
    clearInterval(this.timer)
    await this.flushing
    await this.flush()
    if (this.queue.length)
      logger.warn("team-relay", "Relay stopped with undelivered events.", { count: this.queue.length })
  }
}
