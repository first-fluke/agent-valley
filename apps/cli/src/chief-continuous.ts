import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import { collectContainerObservation } from "@agent-valley/core/chief/container-observation"
import { containerObservationLines } from "@agent-valley/core/chief/container-observation-state"
import { type ContinuousOperation, operationSchema } from "@agent-valley/core/chief/continuous-contract"
import { type ContinuousOperationPorts, runContinuousOperation } from "@agent-valley/core/chief/continuous-operation"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import { prepareContinuousBaseline } from "@agent-valley/core/chief/continuous-workspace"
import { finalizeAbandonedRuns } from "@agent-valley/core/chief/execution"
import { clearedGitEnvironment } from "@agent-valley/core/chief/parallel-git"
import { markdown } from "@agent-valley/core/chief/reports"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { type Command, Option } from "commander"
import { type OrderOptions, resolveOrderConfig } from "./chief-config"
import { decideContinuousGoal } from "./chief-continuous-decision"
import { applyResumeOptions } from "./chief-resume"
import { abortableDelay, superviseOrder } from "./chief-supervisor"
import { assertNotManagedRun } from "./managed-run"

const execute = promisify(execFile)
const orderKeys = [
  "workspace",
  "verify",
  "actor",
  "model",
  "director",
  "actors",
  "oma",
  "timeout",
  "repairs",
  "rounds",
  "parallel",
  "runs",
  "duration",
  "cost",
  "nativeModel",
] as const
const decisionBudgetKeys = ["runs", "duration", "cost", "accountRun", "accountCost"] as const

export interface ContinuousOptions extends OrderOptions {
  cycles?: string
  interval?: string
}

function integerOption(value: string | undefined, name: string, maximum: number): number | undefined {
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`)
  return number
}

export function operationStore(root: string): ContinuousOperationStore {
  return new ContinuousOperationStore(join(resolve(root), ".agent-valley", "operations"))
}

/** Restoring the existing delivery target does not perform a push or expose its potentially credentialed URL. */
export async function restoreOperationOrigin(repository: string, workspace: string): Promise<void> {
  const env = { ...process.env, ...clearedGitEnvironment }
  let upstream: string
  try {
    upstream = (await execute("git", ["remote", "get-url", "origin"], { cwd: repository, env })).stdout.trim()
  } catch (error) {
    if ((error as { code?: number }).code === 2) return
    throw new Error(
      "Cannot read the original repository delivery remote. Repair its Git configuration before resuming.",
    )
  }
  if (!upstream) return
  try {
    const existing = await execute("git", ["remote"], { cwd: workspace, env })
    await execute(
      "git",
      ["remote", existing.stdout.split(/\s+/).includes("origin") ? "set-url" : "add", "origin", upstream],
      {
        cwd: workspace,
        env,
      },
    )
  } catch {
    throw new Error(
      "Cannot restore the mission's original delivery remote. Repair its Git configuration before resuming.",
    )
  }
}

async function newOperation(
  charter: string | undefined,
  options: ContinuousOptions,
  root: string,
  id: string,
): Promise<ContinuousOperation> {
  if (options.accountRun !== undefined || options.accountCost !== undefined)
    throw new Error("Use --resume <operation-id> to reconcile an active decision run's observed cost.")
  if (!charter?.trim() || charter.length > 32_000)
    throw new Error(
      'Give a nonempty goal up to 32 KB: av order "Keep improving service quality and revenue" --workspace /repo.',
    )
  const config = await resolveOrderConfig(root, options)
  const chief = config.personas.find((actor) => actor.id === config.chiefId)
  if (!chief) throw new Error("The configured Chief Director is missing. Restore the Actor roster before starting.")
  const settings: ContinuousOperation["settings"] = {}
  for (const key of orderKeys) {
    const value = options[key]
    if (value !== undefined) settings[key] = value
  }
  const repositoryRoot = await realpath(config.workspace)
  Object.assign(settings, {
    workspace: repositoryRoot,
    verify: config.verifyCommand,
    actor: chief.agentType,
    director: chief.id,
    timeout: String(config.timeoutSec),
    repairs: String(config.maxRepairs),
    rounds: String(config.maxRounds),
    parallel: String(config.executionPolicy.maxParallel),
    runs: String(config.executionPolicy.maxRuns),
    duration: String(config.executionPolicy.maxDurationSec),
    oma: config.oma,
    ...(chief.model ? { model: chief.model } : { nativeModel: true }),
    ...(config.executionPolicy.maxEstimatedCostUsd !== undefined
      ? { cost: String(config.executionPolicy.maxEstimatedCostUsd) }
      : {}),
  })
  if (typeof settings.actors === "string") settings.actors = resolve(root, settings.actors)
  const now = new Date().toISOString()
  return operationSchema.parse({
    id,
    repositoryRoot,
    charter: charter.trim(),
    settings,
    phase: "deciding",
    createdAt: now,
    updatedAt: now,
    completedCycles: 0,
    cycleLimit: integerOption(options.cycles, "--cycles", 1_000_000),
    waitIntervalSec: integerOption(options.interval, "--interval", 86_400) ?? 300,
    containerObservationPolicy: config.containerObservationPolicy,
    history: [],
  })
}

/** Save an operation identity before a background caller launches any decision or Actor. */
export async function initializeOperation(
  charter: string,
  options: ContinuousOptions,
  root = process.cwd(),
  id: string = randomUUID(),
): Promise<ContinuousOperation> {
  assertNotManagedRun()
  root = await realpath(root)
  const storage = operationStore(root)
  const unlock = await storage.lock(id)
  try {
    const existing = await storage.load(id).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existing) throw new Error(`Operation ${id} already exists. Use av order --resume ${id}.`)
    const operation = await newOperation(charter, options, root, id)
    await storage.save(operation)
    return operation
  } finally {
    await unlock()
  }
}

export function renderOperationReport(operation: ContinuousOperation): string {
  const lines = [
    `# Operation ${operation.id}`,
    "",
    `Charter: ${operation.charter}`,
    `Status: ${operation.phase}`,
    `Verified completed improvements: ${operation.completedCycles}${operation.cycleLimit ? ` / ${operation.cycleLimit}` : ""}`,
    `Chief Director: ${operation.settings.actor} / ${operation.settings.model ?? "pinned native default"}`,
    "",
    "AV chooses a concrete improvement, verifies and reviews it, keeps the accepted result, then selects the next improvement. Model calls and API charges can continue until stopped; token savings are not its success criterion.",
    "",
  ]
  if (operation.currentMissionId) lines.push(`Current child: ${operation.currentMissionId}`)
  if (operation.decisionId) {
    lines.push(`Decision checkpoint: ${operation.decisionId}`)
    lines.push(`Decision usage record: .agent-valley/operation-decisions/${operation.id}/${operation.decisionId}.json`)
  }
  if (operation.baseline) lines.push(`Accepted workspace: ${operation.baseline.path}`)
  if (operation.decision) lines.push(`Latest decision: ${operation.decision.action} — ${operation.decision.reason}`)
  if (operation.nextRunAt) lines.push(`Next decision: ${operation.nextRunAt}`)
  if (operation.recovery) {
    lines.push(
      `Recovery disposition: ${operation.recovery.disposition}; ${operation.recovery.target} ${operation.recovery.checkpointId}; ${operation.recovery.attempts} attempts.`,
    )
    lines.push(`Recovery evidence: ${markdown(operation.recovery.reason, 16_000)}`)
    if (operation.recovery.nextRunAt) lines.push(`Next recovery: ${operation.recovery.nextRunAt}`)
  }
  if (operation.error) lines.push(`Paused reason: ${operation.error}`)
  lines.push(
    ...containerObservationLines(operation.containerObservationPolicy, operation.containerObservation).map((line) =>
      markdown(line, 2_200),
    ),
  )
  if (operation.containerObservationRevision)
    lines.push(`Observation transition: ${operation.containerObservationRevision}`)
  for (const entry of operation.history) {
    lines.push("", `## ${entry.goal}`, "", entry.reason, `Verified child: ${entry.missionId}`)
    if (entry.evidence.length) lines.push(`Evidence: ${entry.evidence.join("; ")}`)
  }
  lines.push("", `Resume: av order --resume ${operation.id}`, "")
  return lines.join("\n")
}

async function saveOperationReport(root: string, operation: ContinuousOperation): Promise<void> {
  const directory = join(root, ".agent-valley", "operation-reports")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, `${operation.id}.md`)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, renderOperationReport(operation), { mode: 0o600, flag: "wx" })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export interface ContinuousRunDependencies {
  signal?: AbortSignal
  decide?: ContinuousOperationPorts["decide"]
  runMission?: ContinuousOperationPorts["runMission"]
  delay?: ContinuousOperationPorts["delay"]
  now?: ContinuousOperationPorts["now"]
  observeContainers?: ContinuousOperationPorts["observeContainers"]
}

/** The operation lock covers selection and acceptance; existing supervisors own child lifecycle and interruption. */
export async function runOperation(
  charter: string | undefined,
  options: ContinuousOptions,
  root = process.cwd(),
  dependencies: ContinuousRunDependencies = {},
): Promise<ContinuousOperation> {
  assertNotManagedRun()
  root = await realpath(root)
  const id = options.resume ?? options.operationId ?? randomUUID()
  const storage = operationStore(root)
  const unlock = await storage.lock(id)
  const controller = new AbortController()
  const stop = () => controller.abort()
  dependencies.signal?.addEventListener("abort", stop, { once: true })
  if (dependencies.signal?.aborted) stop()
  if (!dependencies.signal) {
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  }
  try {
    let operation: ContinuousOperation
    if (options.resume) {
      if (charter !== undefined)
        throw new Error("An operation keeps its original charter. Omit the charter when using --resume.")
      if (
        orderKeys.some((key) => options[key] !== undefined && !(decisionBudgetKeys as readonly string[]).includes(key))
      )
        throw new Error(
          "An operation retains its Chief Director and child settings. Reconcile or resume its active child with av order; omit Actor/settings flags on operation resume.",
        )
      operation = await storage.load(id)
      if (decisionBudgetKeys.some((key) => options[key] !== undefined)) {
        if (operation.currentMissionId || !operation.decisionId)
          throw new Error(
            "Operation resume budget reconciliation applies only to an active decision checkpoint. Adjust the current child's budget with av order --resume <child-id>.",
          )
        const decisions = new MissionStore(join(root, ".agent-valley", "operation-decisions", operation.id))
        const unlockDecision = await decisions.lock(operation.decisionId)
        try {
          const decision = await decisions.load(operation.decisionId)
          if (decision.status === "completed")
            throw new Error(
              "This decision is already completed. Omit decision budget flags and resume the saved result.",
            )
          await decisions.recoverProcesses(decision.id)
          finalizeAbandonedRuns(decision)
          const adjustments: OrderOptions = { resume: decision.id }
          for (const key of decisionBudgetKeys) if (options[key] !== undefined) adjustments[key] = options[key]
          applyResumeOptions(decision, undefined, adjustments)
          await decisions.save(decision)
          operation.recovery = undefined
        } finally {
          await unlockDecision()
        }
      }
      const cycleLimit = integerOption(options.cycles, "--cycles", 1_000_000)
      if (cycleLimit !== undefined) {
        if (cycleLimit <= operation.completedCycles)
          throw new Error("--cycles must exceed the operation's completed cycle count when extending it.")
        operation.cycleLimit = cycleLimit
        if (operation.phase === "completed") operation.phase = "deciding"
      }
      const interval = integerOption(options.interval, "--interval", 86_400)
      if (interval !== undefined) operation.waitIntervalSec = interval
      if (operation.repositoryRoot !== (await realpath(String(operation.settings.workspace))))
        throw new Error("Operation repository identity changed. Restore its original repository before resuming.")
    } else {
      if (
        await storage.load(id).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
      )
        throw new Error(`Operation ${id} already exists. Use --resume ${id}.`)
      operation = await newOperation(charter, options, root, id)
    }
    await storage.save(operation)
    await saveOperationReport(root, operation)
    console.log(`Operation ${id}\nCharter: ${operation.charter}\nResume: av order --resume ${id}`)
    const missions = new MissionStore(join(root, ".agent-valley", "missions"))
    return await runContinuousOperation(operation, {
      signal: controller.signal,
      ...(dependencies.now ? { now: dependencies.now } : {}),
      observeContainers:
        dependencies.observeContainers ??
        ((current) => {
          if (!current.containerObservationPolicy) throw new Error("Restore the saved container observation policy.")
          return collectContainerObservation(current.containerObservationPolicy, current.containerObservation, {
            signal: controller.signal,
            now: dependencies.now,
          })
        }),
      decide:
        dependencies.decide ??
        ((current, decisionId) => decideContinuousGoal(current, decisionId, root, { signal: controller.signal })),
      findMission: (missionId) =>
        missions.load(missionId).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        }),
      runMission:
        dependencies.runMission ??
        (async (current, missionId, goal, baselinePath) => {
          const saved = await missions.load(missionId).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined
            throw error
          })
          return superviseOrder(
            saved ? undefined : goal,
            saved
              ? { resume: missionId, once: true }
              : {
                  ...(current.settings as OrderOptions),
                  once: true,
                  missionId,
                  baselineWorkspace: baselinePath,
                  operationId: current.id,
                },
            root,
            { signal: controller.signal },
          )
        }),
      accept: async (current, mission?: Mission) => {
        return prepareContinuousBaseline(
          current.repositoryRoot,
          current.id,
          mission?.workspace.path ?? current.repositoryRoot,
          mission?.id,
          mission?.verification?.fingerprint,
        )
      },
      save: async (current) => {
        await storage.save(current)
        await saveOperationReport(root, current)
      },
      delay: dependencies.delay ?? abortableDelay,
    })
  } finally {
    dependencies.signal?.removeEventListener("abort", stop)
    if (!dependencies.signal) {
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
    await unlock()
  }
}

export function registerContinuousCommands(program: Command): void {
  program
    .command("operate [charter]", { hidden: true })
    .description("Deprecated alias for av order; resume existing operating charters")
    .option("--workspace <path>", "Target Git repository (defaults to av.yaml)")
    .option("--verify <command>", "Trusted completion check for each improvement")
    .option("--actor <type>", "Pinned Chief Director CLI")
    .option("--model <id>", "Pinned Chief Director model")
    .option("--director <id>", "Chief Director Actor ID")
    .option("--actors <file>", "Configured YAML Actor roster")
    .option("--oma", "Require OMA completion receipts for workers")
    .option("--timeout <seconds>", "Timeout per Actor/check")
    .option("--repairs <count>", "Repair limit per task/final review")
    .option("--rounds <count>", "Recovery decision limit per improvement")
    .option("--parallel <count>", "Actor concurrency per improvement")
    .option("--runs <count>", "Initial Actor call limit; on resume, increase the active decision checkpoint limit")
    .option("--duration <seconds>", "Initial wall-time limit; on resume, increase the active decision checkpoint limit")
    .option("--cost <usd>", "Initial estimated cost limit; on resume, increase the active decision checkpoint limit")
    .option("--account-run <run-id>", "On resume, reconcile an active decision run whose usage/cost was lost")
    .option("--account-cost <usd>", "Observed USD cost for the decision --account-run after inspecting billing")
    .option("--cycles <count>", "Cumulative verified improvement limit; default continues until stopped")
    .option("--interval <seconds>", "Wait before selecting again when no new goal is justified (default 300)")
    .option("--resume <id>", "Resume the saved charter and accepted work")
    .addOption(new Option("--operation-id <id>", "Internal operation identity").hideHelp())
    .action(async (charter: string | undefined, options: ContinuousOptions) => {
      const operation = await runOperation(charter, options)
      console.log(`Operation ${operation.id}: ${operation.phase}; ${operation.completedCycles} verified improvements.`)
      if (operation.error) console.error(operation.error)
      process.exitCode = operation.phase === "paused" ? 2 : 0
    })
  program
    .command("operations")
    .description("List saved operating charters or read an operation report")
    .option("--report <id>", "Print the saved operation report")
    .action(async (options: { report?: string }) => {
      const storage = operationStore(process.cwd())
      if (options.report) {
        console.log(renderOperationReport(await storage.load(options.report)))
        return
      }
      const operations = await storage.list()
      if (!operations.length) console.log("No operations yet. Run av order --help.")
      for (const operation of operations) {
        console.log(
          `${operation.id}  ${operation.phase}  ${operation.completedCycles} completed  ${operation.charter.slice(0, 100)}`,
        )
        if (operation.currentMissionId) console.log(`  Child: ${operation.currentMissionId}`)
        if (operation.error) console.log(`  ${operation.error}`)
      }
    })
}
