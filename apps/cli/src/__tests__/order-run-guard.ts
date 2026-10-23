import { AsyncLocalStorage } from "node:async_hooks"

type RegistrationObserver = (event: string | symbol, listener: unknown) => void

interface OwnedRun {
  interruptHandlers: Set<unknown>
  terminateHandlers: Set<unknown>
  observer?: RegistrationObserver
  pending: boolean
  failed: boolean
  error?: unknown
  settled: Promise<void>
}

const orderContext = new AsyncLocalStorage<OwnedRun>()

function stopObserving(owned: OwnedRun) {
  if (!owned.observer) return
  process.removeListener("newListener", owned.observer)
  delete owned.observer
}

/** Keep runOrder's signal handlers and fixture alive until its finally block finishes. */
export function createOrderRunGuard(cleanupTimeoutMs = 20_000) {
  let current: OwnedRun | undefined
  let closing = false

  function run<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) throw new Error("Order teardown has started; do not launch another order in this fixture.")
    if (current?.pending) throw new Error("Join the previous runOrder before starting another order.")
    const owned: OwnedRun = {
      interruptHandlers: new Set(),
      terminateHandlers: new Set(),
      pending: true,
      failed: false,
      settled: Promise.resolve(),
    }
    current = owned
    // Registrations from other async contexts can interleave while runOrder awaits its lock.
    owned.observer = (event, listener) => {
      if (orderContext.getStore() !== owned) return
      if (event === "SIGINT") owned.interruptHandlers.add(listener)
      if (event === "SIGTERM") owned.terminateHandlers.add(listener)
    }
    process.on("newListener", owned.observer)
    const result = orderContext.run(owned, () => Promise.resolve().then(operation))
    owned.settled = result.then(
      () => {
        owned.pending = false
        stopObserving(owned)
      },
      (error: unknown) => {
        owned.pending = false
        owned.failed = true
        owned.error = error
        stopObserving(owned)
      },
    )
    return result
  }

  async function stopAndJoin(): Promise<void> {
    closing = true
    const owned = current
    if (!owned) return
    let interrupted = false
    let interruptFailed = false
    let interruptError: unknown
    const interrupt = () => {
      if (!owned.pending || interrupted) return
      // Compare identities across the separately typed SIGINT and SIGTERM listeners.
      const terminate = new Set<unknown>(process.listeners("SIGTERM"))
      // runOrder installs the same closure for both signals. Never broadcast a process signal.
      const listener = process
        .listeners("SIGINT")
        .find(
          (candidate) =>
            owned.interruptHandlers.has(candidate) &&
            owned.terminateHandlers.has(candidate) &&
            terminate.has(candidate),
        )
      if (!listener) return
      interrupted = true
      try {
        listener("SIGINT")
      } catch (error) {
        interruptFailed = true
        interruptError = error
      }
    }
    interrupt()
    // The order can still be awaiting its lock when teardown starts.
    const capture = setInterval(interrupt, 10)
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        owned.settled,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  `runOrder did not settle within ${cleanupTimeoutMs}ms after interruption. ` +
                    "The fixture was retained; inspect its processes before retrying.",
                ),
              ),
            cleanupTimeoutMs,
          )
        }),
      ])
    } finally {
      clearInterval(capture)
      clearTimeout(deadline)
      stopObserving(owned)
    }
    current = undefined
    if (interruptFailed) throw interruptError
    // A rejected finally/close may mean cleanup is unconfirmed. Preserve the fixture.
    if (owned.failed) throw owned.error
  }

  return { run, stopAndJoin }
}
