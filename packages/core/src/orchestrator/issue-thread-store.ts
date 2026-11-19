/**
 * IssueThreadStore — bounded in-memory threads, one per issue, that operators
 * follow live from the dashboard and `av attach`.
 *
 * Owned by the Orchestrator facade (CONSTRAINTS.md §6): nothing else holds a
 * writable reference. Threads are a viewing aid, not durable state; they are
 * lost on restart.
 *
 * Bounds: `MAX_THREADS` issues, `MAX_THREAD_ENTRIES` entries per issue,
 * `MAX_THREAD_ENTRY_CHARS` characters per entry.
 */

import type { ThreadEntry, ThreadEntryKind, ThreadUpdate } from "../domain/issue-thread"
import { logger } from "../observability/logger"

export const MAX_THREADS = 50
export const MAX_THREAD_ENTRIES = 400
export const MAX_THREAD_ENTRY_CHARS = 8_000
/**
 * Output chunks from one attempt that arrive this close together are one
 * streamed message (token deltas); a longer gap starts a new entry.
 */
export const OUTPUT_COALESCE_WINDOW_MS = 1_000

export type ThreadListener = (update: ThreadUpdate) => void

/** Read side handed to the Presentation layer. */
export type IssueThreadReader = Pick<IssueThreadStore, "read" | "subscribe">

interface Thread {
  entries: ThreadEntry[]
  nextSeq: number
  lastAppendAt: number
  listeners: Set<ThreadListener>
}

export class IssueThreadStore {
  private readonly threads = new Map<string, Thread>()

  constructor(private readonly now: () => number = Date.now) {}

  append(issueKey: string, kind: ThreadEntryKind, text: string, attemptId?: string): void {
    if (!issueKey || !text) return
    const thread = this.touch(issueKey)
    const now = this.now()
    const tail = thread.entries[thread.entries.length - 1]
    const chunk = text.slice(0, MAX_THREAD_ENTRY_CHARS)

    const extendsTail =
      kind === "output" &&
      tail?.kind === "output" &&
      tail.attemptId === attemptId &&
      now - thread.lastAppendAt <= OUTPUT_COALESCE_WINDOW_MS &&
      tail.text.length + chunk.length <= MAX_THREAD_ENTRY_CHARS
    thread.lastAppendAt = now

    if (extendsTail && tail) {
      tail.text += chunk
      this.notify(issueKey, thread, { issueKey, entry: { ...tail, text: chunk }, appended: true })
      return
    }

    const entry: ThreadEntry = { seq: thread.nextSeq++, at: new Date(now).toISOString(), kind, text: chunk }
    if (attemptId) entry.attemptId = attemptId
    thread.entries.push(entry)
    if (thread.entries.length > MAX_THREAD_ENTRIES) thread.entries.shift()
    this.notify(issueKey, thread, { issueKey, entry: { ...entry }, appended: false })
  }

  /** Snapshot of the retained entries, oldest first. */
  read(issueKey: string): ThreadEntry[] {
    return (this.threads.get(issueKey)?.entries ?? []).map((entry) => ({ ...entry }))
  }

  /** Follow a thread. Subscribing before its first entry is allowed. */
  subscribe(issueKey: string, listener: ThreadListener): () => void {
    const thread = this.touch(issueKey)
    thread.listeners.add(listener)
    return () => {
      thread.listeners.delete(listener)
      // A thread nobody wrote to and nobody watches holds no information.
      if (thread.listeners.size === 0 && thread.entries.length === 0 && this.threads.get(issueKey) === thread) {
        this.threads.delete(issueKey)
      }
    }
  }

  /** Get or create the thread and mark it most recently used. */
  private touch(issueKey: string): Thread {
    const existing = this.threads.get(issueKey)
    if (existing) {
      this.threads.delete(issueKey)
      this.threads.set(issueKey, existing)
      return existing
    }
    const thread: Thread = { entries: [], nextSeq: 1, lastAppendAt: 0, listeners: new Set() }
    this.threads.set(issueKey, thread)
    this.evict(issueKey)
    return thread
  }

  /** Drop least recently used threads nobody is watching. Watched threads and `keep` stay. */
  private evict(keep: string): void {
    for (const [key, thread] of this.threads) {
      if (this.threads.size <= MAX_THREADS) return
      if (key !== keep && thread.listeners.size === 0) this.threads.delete(key)
    }
  }

  private notify(issueKey: string, thread: Thread, update: ThreadUpdate): void {
    for (const listener of thread.listeners) {
      try {
        listener(update)
      } catch (err) {
        // A broken viewer must never disturb the actor's output path.
        logger.warn("orchestrator", "Issue thread listener failed", { issueKey, error: String(err) })
      }
    }
  }
}
