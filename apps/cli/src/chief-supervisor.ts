import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { automaticMissionRecovery } from "@agent-valley/core/chief/continuous-recovery"
import { assertExecutionDeadline, executionState, MissionPause, recordPause } from "@agent-valley/core/chief/execution"
import { fallbackReport } from "@agent-valley/core/chief/reports"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import type { OrderOptions } from "./chief-config"
import { saveAndDeliverMissionReport } from "./chief-delivery"
import { orderExitCode } from "./chief-outcome"
import { assertNotManagedRun } from "./managed-run"

export function orderWorkerArgs(goal: string | undefined, options: OrderOptions, id: string): string[] {
  const args = ["order", "--once", "--worker"]
  const excluded = new Set(["once", "worker", "missionId", "supervise"])
  for (const [key, value] of Object.entries(options)) {
    if (excluded.has(key) || value === undefined || value === false) continue
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    args.push(flag)
    if (value !== true) args.push(String(value))
  }
  if (!options.resume) args.push("--mission-id", id)
  if (goal !== undefined) args.push("--", goal)
  return args
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      reject(new Error("Order supervision interrupted."))
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", abort)
        resolveWait()
      },
      Math.min(30_000, Math.max(1, ms)),
    )
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export interface OrderSupervisorDependencies {
  runWorker?: (args: string[], root: string, signal: AbortSignal) => Promise<number | null>
  delay?: typeof abortableDelay
  signal?: AbortSignal
}

function runWorker(args: string[], root: string, signal: AbortSignal): Promise<number | null> {
  return new Promise((resolveExit, reject) => {
    const entry = process.argv[1]
    if (!entry) {
      reject(new Error("CLI entry point is unavailable. Run av order from the installed CLI."))
      return
    }
    const child = spawn(process.execPath, [entry, ...args], { cwd: root, stdio: "inherit" })
    const interrupt = () => child.kill("SIGTERM")
    signal.addEventListener("abort", interrupt, { once: true })
    if (signal.aborted) interrupt()
    child.once("error", (error) => {
      signal.removeEventListener("abort", interrupt)
      reject(error)
    })
    child.once("exit", (code) => {
      signal.removeEventListener("abort", interrupt)
      resolveExit(code)
    })
  })
}

/** Parent owns restart scheduling; child owns the mission lock and every Actor process. */
export async function superviseOrder(
  goal: string | undefined,
  options: OrderOptions,
  root: string,
  dependencies: OrderSupervisorDependencies = {},
): Promise<Mission> {
  assertNotManagedRun()
  const id = options.resume ?? options.missionId ?? randomUUID()
  const store = new MissionStore(join(root, ".agent-valley/missions"))
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  dependencies.signal?.addEventListener("abort", interrupt, { once: true })
  if (dependencies.signal?.aborted) interrupt()
  if (!dependencies.signal) {
    process.once("SIGINT", interrupt)
    process.once("SIGTERM", interrupt)
  }
  let args = orderWorkerArgs(goal, options, id)
  let returned: Mission | undefined
  try {
    while (!controller.signal.aborted) {
      const workerExit = await (dependencies.runWorker ?? runWorker)(args, root, controller.signal)
      const mission = await store.load(id).catch(() => undefined)
      if (!mission)
        throw new Error(
          "Order could not be initialized. Correct its configuration and retry; no automatic initialization replay was attempted.",
        )
      returned = mission
      const terminal = ["completed", "failed", "paused"].includes(mission.status)
      if (!controller.signal.aborted && terminal && workerExit !== 0 && workerExit !== orderExitCode(mission))
        throw new Error(
          `Order worker exited ${workerExit === null ? "by signal" : `with code ${workerExit}`} after saving ${mission.status} for ${id}. ` +
            (mission.status === "completed"
              ? `Verified work remains completed. Inspect .agent-valley/reports/${id}.md and the worker log; use av reports retry for pending deliveries.`
              : `The saved outcome remains unresolved. Checkpoint: .agent-valley/missions/${id}.json; report: .agent-valley/reports/${id}.md.`),
        )
      const recovery = automaticMissionRecovery(mission)
      if (controller.signal.aborted || !mission.executionPolicy?.autoResume || (terminal && !recovery.retry))
        return mission
      assertExecutionDeadline(mission)
      const remainingTime = () =>
        mission.executionPolicy && mission.execution
          ? Date.parse(mission.execution.startedAt) + mission.executionPolicy.maxDurationSec * 1_000 - Date.now()
          : Infinity
      if (mission.status === "waiting" && mission.execution?.nextRunAt && (workerExit === 0 || workerExit === 2)) {
        while (Date.parse(mission.execution.nextRunAt) > Date.now()) {
          assertExecutionDeadline(mission)
          await (dependencies.delay ?? abortableDelay)(
            Math.min(Date.parse(mission.execution.nextRunAt) - Date.now(), remainingTime()),
            controller.signal,
          )
        }
      } else {
        if (!recovery.retry) return mission
        const unlock = await store.lock(id)
        try {
          const latest = await store.load(id)
          const state = executionState(latest)
          state.crashRestarts = (state.crashRestarts ?? 0) + 1
          if (state.crashRestarts > (latest.executionPolicy?.maxRetries ?? 3)) {
            recordPause(
              latest,
              new MissionPause(
                "Worker recovery exhausted automatic restart attempts. The original goal remains unresolved and its checkpoint was retained.",
                "environment",
              ),
            )
            await store.save(latest)
            returned = latest
            return latest
          }
          latest.history.push({
            at: new Date().toISOString(),
            stage: "worker-restart",
            message: `Restarting crashed mission worker, attempt ${state.crashRestarts} (exit ${workerExit ?? "signal"}).`,
          })
          await store.save(latest)
        } finally {
          await unlock()
        }
        await (dependencies.delay ?? abortableDelay)(Math.min(1_000, remainingTime()), controller.signal)
      }
      assertExecutionDeadline(mission)
      args = orderWorkerArgs(undefined, { resume: id }, id)
    }
    returned = await store.load(id)
    return returned
  } catch (error) {
    if (error instanceof MissionPause && !controller.signal.aborted) {
      const unlock = await store.lock(id)
      try {
        const latest = await store.load(id)
        recordPause(latest, error)
        latest.report = fallbackReport(latest)
        await store.save(latest)
        await saveAndDeliverMissionReport(latest, root)
        returned = latest
        return latest
      } finally {
        await unlock()
      }
    }
    if (!controller.signal.aborted) throw error
    const existing = await store.load(id).catch(() => undefined)
    if (!existing) throw error
    returned = existing
    return existing
  } finally {
    if (controller.signal.aborted) {
      const existing = await store.load(id).catch(() => undefined)
      if (existing && existing.status !== "completed") {
        const unlock = await store.lock(id)
        try {
          const latest = await store.load(id)
          if (latest.status !== "completed") {
            recordPause(
              latest,
              new MissionPause(
                "Operator stopped mission supervision. Resume explicitly with --retry; automatic watchers must not restart it.",
                "interrupted",
              ),
            )
            latest.history.push({
              at: new Date().toISOString(),
              stage: "paused",
              message: latest.error ?? "Operator stopped supervision.",
            })
            await store.save(latest)
            if (returned) Object.assign(returned, latest)
          }
        } finally {
          await unlock()
        }
      }
    }
    dependencies.signal?.removeEventListener("abort", interrupt)
    if (!dependencies.signal) {
      process.removeListener("SIGINT", interrupt)
      process.removeListener("SIGTERM", interrupt)
    }
  }
}
