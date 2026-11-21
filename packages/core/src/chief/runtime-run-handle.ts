import type { RunAttempt } from "../domain/models"
import { AgentRunError, type RunHandle } from "../domain/ports/agent-runner"
import { MissionPause } from "./execution"

export async function joinRun(run: RunHandle): Promise<void> {
  try {
    await run.result
  } catch (error) {
    if (error instanceof AgentRunError && error.outcomeUnknown) throw error
  }
}

export async function stopRun(run: RunHandle): Promise<void> {
  if (!run.isAlive()) {
    await joinRun(run)
    return
  }
  if (run.executionCapabilities.cancellation === "unsupported")
    throw new Error("Runtime cannot confirm cancellation. Reconcile the execution before resuming.")
  await run.cancel()
  if (run.executionCapabilities.cancellation !== "confirmed")
    throw new Error(
      "Runtime accepted cancellation without confirming completion. Reconcile the execution before resuming.",
    )
  await joinRun(run)
}

export async function awaitRun(run: RunHandle, attempt: RunAttempt, signal?: AbortSignal): Promise<RunAttempt> {
  if (!signal) return run.result
  let abort: (() => void) | undefined
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => {
      void stopRun(run).then(
        () =>
          reject(
            signal.reason instanceof MissionPause
              ? signal.reason
              : new Error("Order interrupted. Resume the saved mission to continue."),
          ),
        (error) =>
          reject(
            new AgentRunError(error instanceof Error ? error.message : String(error), attempt, {
              outcomeUnknown: true,
            }),
          ),
      )
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([run.result, interrupted])
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
  }
}
