/**
 * QueuedMessages — bookkeeping for a CLI that keeps stdin open and takes
 * follow-up messages as NDJSON while it runs (Claude, Antigravity).
 *
 * Such a CLI reports each turn's result separately. A message written while a
 * turn is running may be folded into that turn or answered in a turn of its
 * own, so a result only ends the run when no message is still waiting. This
 * class tracks the waiting messages and the results held back because of them.
 */

import type { Writable } from "node:stream"

/**
 * How long a finished turn waits for the CLI to pick up a message that was
 * queued behind it. Any stream event inside the window means the follow-up
 * turn started; silence means the message was never taken.
 */
export const QUEUED_MESSAGE_GRACE_MS = 15_000

export class QueuedMessages {
  /** Ids of messages written to stdin that the CLI has not taken yet, oldest first. */
  private waiting: string[] = []
  /** Outputs of turns that ended while a message was still waiting behind them. */
  private held: string[] | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param graceMs  current grace window (read each time a turn is held)
   * @param onAbandoned  called when a held turn's queued message is never taken
   */
  constructor(
    private readonly graceMs: () => number,
    private readonly onAbandoned: () => void,
  ) {}

  reset(): void {
    this.activity()
    this.waiting = []
    this.held = null
  }

  /**
   * Write one message line and count it as waiting. Rejects, with the restart
   * hint callers surface to the operator, when stdin cannot take it.
   */
  async write(stdin: Writable | null | undefined, id: string, message: unknown, label: string): Promise<void> {
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      throw new Error(
        `${label} stdin is closed, so the message cannot be delivered. Restart the run with the message instead.`,
      )
    }
    this.waiting.push(id)
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(message)}\n`, "utf-8", (error) => {
        if (!error) return resolve()
        this.waiting = this.waiting.filter((waitingId) => waitingId !== id)
        reject(
          new Error(
            `${label} did not accept the message (${error.message}). Restart the run with the message instead.`,
          ),
        )
      })
    })
  }

  /** The CLI took a message: the one with this id when it echoes ids, otherwise the oldest. */
  taken(id?: string): void {
    const index = id === undefined ? -1 : this.waiting.indexOf(id)
    // An unknown id falls back to the oldest message: the CLI takes them in order.
    this.waiting.splice(Math.max(index, 0), 1)
  }

  /** True while a written message has not been taken. */
  get pending(): boolean {
    return this.waiting.length > 0
  }

  /** A turn ended with a message still waiting: keep its output until the follow-up turn ends. */
  hold(output: string): void {
    this.held = [...(this.held ?? []), output]
    this.activity()
    this.timer = setTimeout(() => {
      this.timer = null
      this.onAbandoned()
    }, this.graceMs())
    this.timer.unref?.()
  }

  get holding(): boolean {
    return this.held !== null
  }

  /** Any sign of life from the CLI: the follow-up turn is underway, or the run is ending. */
  activity(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Outputs of the held turns, oldest first. Clears them. */
  release(): string[] {
    this.activity()
    const outputs = this.held ?? []
    this.held = null
    return outputs
  }
}
