import { spawn } from "node:child_process"

interface WorkerOptions {
  entry?: string
  terminateGraceMs?: number
  killWaitMs?: number
}

export class WorkerTerminationError extends Error {}

/** Signal only this owned child; its native Actor markers have separate identity-checked recovery. */
export function runOrderWorker(
  args: string[],
  root: string,
  signal: AbortSignal,
  options: WorkerOptions = {},
): Promise<number | null> {
  if (signal.aborted) return Promise.resolve(null)
  const entry = options.entry ?? process.argv[1]
  if (!entry) return Promise.reject(new Error("CLI entry point is unavailable. Run av order from the installed CLI."))
  return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" })
    let terminateTimer: ReturnType<typeof setTimeout> | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let signalError: unknown
    const cleanup = () => {
      clearTimeout(terminateTimer)
      clearTimeout(killTimer)
      signal.removeEventListener("abort", interrupt)
    }
    const send = (kind: NodeJS.Signals) => {
      try {
        child.kill(kind)
      } catch (error) {
        signalError = error
      }
    }
    const interrupt = () => {
      send("SIGTERM")
      terminateTimer = setTimeout(() => {
        send("SIGKILL")
        killTimer = setTimeout(() => {
          cleanup()
          child.unref()
          reject(
            new WorkerTerminationError(
              `Order worker ${child.pid ?? "without PID"} termination could not be confirmed. Preserve its checkpoint and process markers before resuming.`,
              { cause: signalError },
            ),
          )
        }, options.killWaitMs ?? 3_000)
      }, options.terminateGraceMs ?? 2_000)
    }
    signal.addEventListener("abort", interrupt, { once: true })
    child.once("error", (error) => {
      cleanup()
      reject(error)
    })
    child.once("exit", (code) => {
      cleanup()
      resolveExit(code)
    })
    if (signal.aborted) interrupt()
  })
}
