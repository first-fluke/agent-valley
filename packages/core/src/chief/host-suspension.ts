/**
 * Host sleep detection for long-running orders.
 *
 * A laptop that sleeps suspends every Actor, reviewer and Chief call in flight. When it wakes, their
 * connections are gone and their inactivity timers expire, which used to look like stalled Actors and a
 * crashed worker: an order left running overnight spent its crash restarts and paused. Timers do not fire
 * while the host is suspended, so a tick that arrives far later than its interval on the wall clock means
 * the process slept in between.
 */
const TICK_MS = 5_000
const GAP_MS = 45_000
/** Failures this long after a wake are still attributed to the sleep: reconnects and probes take minutes. */
export const SUSPENSION_WINDOW_MS = 15 * 60_000
/** The host counts as awake again after this long without another suspension. */
export const STABLE_WAKE_MS = 120_000

let lastTick: number | undefined
let resumedAt: number | undefined

/** Records a wake when the wall clock ran ahead of the last observation. Inactive until the watch starts. */
export function observeHostClock(now = Date.now()): void {
  if (lastTick === undefined) return
  if (now - lastTick > GAP_MS) resumedAt = now
  lastTick = now
}

/** Started once by the order command. Library callers and tests that never start it keep prior behaviour. */
export function watchHostSuspension(now = Date.now()): () => void {
  lastTick = now
  const timer = setInterval(() => observeHostClock(), TICK_MS)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    lastTick = undefined
    resumedAt = undefined
  }
}

export function hostResumedWithin(windowMs = SUSPENSION_WINDOW_MS, now = Date.now()): boolean {
  observeHostClock(now)
  return resumedAt !== undefined && now - resumedAt <= windowMs
}

export function hostResumedSince(since: number, now = Date.now()): boolean {
  observeHostClock(now)
  return resumedAt !== undefined && resumedAt >= since
}

/** Lost connections and expired inactivity timers: what a suspended native CLI reports after the wake. */
const SLEEP_ARTEFACT =
  /Agent stalled: no activity for \d+s|Agent timed out after \d|RPC timeout for|econnreset|etimedout|epipe|socket hang up|fetch failed|network error|connection (?:closed|lost|reset)|stream (?:closed|disconnected)/i

/** A verdict or a check result quotes such text from the work it judged; it is evidence, not a lost call. */
const JUDGED_WORK = /failed independent review|command checks fail/i

/** A transport or inactivity failure reported shortly after the host woke is the sleep, not the Actor. */
export function isHostSleepArtefact(reason: string, now = Date.now()): boolean {
  const head = reason.slice(0, 400)
  return SLEEP_ARTEFACT.test(head) && !JUDGED_WORK.test(head) && hostResumedWithin(SUSPENSION_WINDOW_MS, now)
}

/**
 * Resolves once the host has stayed awake for STABLE_WAKE_MS. A closed laptop wakes for a few seconds every
 * quarter of an hour; work started in such a window is suspended again before it can finish.
 */
export async function hostStablyAwake(
  wait: (ms: number) => Promise<void>,
  now: () => number = Date.now,
): Promise<boolean> {
  let waited = false
  while (hostResumedWithin(STABLE_WAKE_MS, now())) {
    waited = true
    await wait(TICK_MS)
  }
  return waited
}
