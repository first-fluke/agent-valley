/**
 * Issue thread — the running conversation between an operator and the actor
 * working on one issue. It spans attempts, so a run that restarts to deliver
 * an operator message keeps its history.
 *
 * Invariant: no imports from outside `domain/`.
 */

/**
 * - `output`   text the actor produced
 * - `tool`     a tool the actor invoked (name plus a one-line argument summary)
 * - `operator` a message a human sent to the actor
 * - `system`   lifecycle markers (started, paused, completed, failed, ...)
 */
export type ThreadEntryKind = "output" | "tool" | "operator" | "system"

export interface ThreadEntry {
  /** Monotonic per thread. Streamed output keeps extending the entry with the same seq. */
  seq: number
  /** ISO-8601 time the entry was opened. */
  at: string
  kind: ThreadEntryKind
  text: string
  attemptId?: string
}

/**
 * A live change to a thread. When `appended` is true, `entry.text` holds only
 * the text added to the existing entry with `entry.seq`; otherwise `entry` is new.
 */
export interface ThreadUpdate {
  issueKey: string
  entry: ThreadEntry
  appended: boolean
}

/** First message on a thread stream: everything retained so far. */
export interface ThreadBacklog {
  issueKey: string
  entries: ThreadEntry[]
}

/** Fold a live update into a client-side copy of the thread. Returns a new array. */
export function applyThreadUpdate(entries: readonly ThreadEntry[], update: ThreadUpdate, limit = 500): ThreadEntry[] {
  const tail = entries[entries.length - 1]
  if (update.appended && tail?.seq === update.entry.seq) {
    return [...entries.slice(0, -1), { ...tail, text: tail.text + update.entry.text }]
  }
  // An append whose entry this client never saw still carries displayable text.
  const next = [...entries, { ...update.entry }]
  return next.length > limit ? next.slice(next.length - limit) : next
}
