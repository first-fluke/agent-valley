import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { MissionCapture } from "@agent-valley/core/chief/capture"
import type { ContinuousOperation } from "@agent-valley/core/chief/continuous-contract"
import { createContinuousMissionWorkspace } from "@agent-valley/core/chief/continuous-workspace"
import { coordinate } from "@agent-valley/core/chief/coordinator"
import { executionState, MissionPause, recordPause } from "@agent-valley/core/chief/execution"
import { loadOrganizationContext } from "@agent-valley/core/chief/organization"
import { ChiefRuntime, missionIssue } from "@agent-valley/core/chief/runtime"
import {
  isServiceShutdown,
  recordServiceShutdown,
  serviceShutdownPause,
} from "@agent-valley/core/chief/service-shutdown"
import { discoverMissionSkills, prepareMissionSkills } from "@agent-valley/core/chief/skills"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { type Command, Option } from "commander"
import { deliverMissionCode, prepareCodeDelivery } from "./chief-code-delivery"
import { deliveryPaths, type OrderOptions, resolveOrderConfig } from "./chief-config"
import { createMissionContainerPorts } from "./chief-containers"
import {
  type ContinuousOptions,
  operationStore,
  registerContinuousCommands,
  restoreOperationOrigin,
  runOperation,
} from "./chief-continuous"
import { saveAndDeliverMissionReport } from "./chief-delivery"
import { createMissionMetricPorts } from "./chief-metrics"
import { registerMissionCommands } from "./chief-missions"
import { orderExitCode, printOrderOutcome } from "./chief-outcome"
import { applyResumeOptions, validateResumeOptions } from "./chief-resume"
import { superviseOrder } from "./chief-supervisor"
import { prepareChiefToolConfig } from "./chief-tool-config"
import { prepareMissionDependencies } from "./chief-workspace-dependencies"
import { assertNotManagedRun } from "./managed-run"

async function organizationContext(repository: string, mission: Mission) {
  const context = await loadOrganizationContext(repository, mission.goal, mission.operatingPolicy?.metricTargets)
  if (mission.operatingPolicy?.memory === false) {
    context.memories = []
    context.outcomes = []
    context.experiments = []
    context.routeEvidence = []
  }
  return context
}

export async function runOrder(
  goal: string | undefined,
  options: OrderOptions,
  root = process.cwd(),
): Promise<Mission> {
  assertNotManagedRun()
  if (
    options.resume &&
    [
      options.deliver,
      options.deliveryPaths,
      options.deliveryMessage,
      options.deliveryRemote,
      options.deliverySkipPrePush,
    ].some((value) => value !== undefined)
  )
    throw new Error(
      "Code delivery retains its saved branch, paths, commit message and hook policy. Resume without replacement delivery options.",
    )
  if (
    !options.resume &&
    [options.retry, options.resolveEffect, options.effectResult, options.accountRun, options.accountCost].some(
      (value) => value !== undefined && value !== false,
    )
  )
    throw new Error("Use --resume <id> for retry, external-effect resolution or cost reconciliation.")
  const store = new MissionStore(join(root, ".agent-valley/missions"))
  const id = options.resume ?? options.missionId ?? randomUUID()
  const unlock = await store.lock(id)
  const abortController = new AbortController()
  const interrupt = () =>
    abortController.abort(
      new MissionPause(
        "Operator stopped the order. Its checks and worktree were retained; repair any interrupted effects before resuming with --retry.",
        "interrupted",
      ),
    )
  const terminate = () => (options.service ? abortController.abort(serviceShutdownPause()) : interrupt())
  const runtime = new ChiefRuntime(store, abortController.signal, (stage, persona) =>
    console.log(`[${stage}] ${persona.name} (${persona.agentType})`),
  )
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", terminate)
  let mission: Mission | undefined
  let capture: MissionCapture | undefined
  let reportSaved = false
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const finishCapture = async () => {
    if (!capture || !mission) return
    const recorder = capture
    capture = undefined
    mission.capture = await recorder.stop()
    await store.save(mission)
  }
  try {
    if (options.resume) {
      validateResumeOptions(goal, options)
      mission = await store.load(id)
      applyResumeOptions(mission, goal, options)
      await store.save(mission)
      await store.recoverProcesses(id, mission)
      if (mission.status === "paused") return mission
    } else {
      if (!goal?.trim())
        throw new Error(
          "Give the chief a goal: av order \"Investigate and fix the login failure\" --workspace /repo --verify 'npm test'.",
        )
      if (goal.length > 32_000)
        throw new Error(
          "Order goal exceeds 32 KB. Put supporting details in repository files and reference them in a shorter goal.",
        )
      const config = await resolveOrderConfig(root, options)
      const codeDelivery = await prepareCodeDelivery(config.workspace, {
        ...options,
        deliveryPaths: deliveryPaths(options.deliveryPaths),
      })
      const operation = options.operationId
        ? await operationStore(await realpath(root)).load(options.operationId)
        : undefined
      if (
        operation &&
        (operation.repositoryRoot !== (await realpath(config.workspace)) ||
          operation.currentMissionId !== id ||
          operation.decision?.action !== "execute" ||
          operation.decision.goal !== goal ||
          operation.baseline?.path !== options.baselineWorkspace)
      )
        throw new Error(
          "Internal child launch does not match its saved operation, goal and accepted baseline. Restore the original operation checkpoint.",
        )
      if (Boolean(options.baselineWorkspace) !== Boolean(options.operationId))
        throw new Error("An internal operation snapshot requires both its operation identity and accepted baseline.")
      const workspace =
        options.baselineWorkspace && options.operationId
          ? await createContinuousMissionWorkspace(
              config.workspace,
              options.operationId,
              options.baselineWorkspace,
              id,
              goal,
            )
          : await new WorkspaceManager(config.workspace).create(
              missionIssue(id, goal),
              undefined,
              codeDelivery ? join(config.workspace, ".agent-valley", "workspaces") : undefined,
            )
      if (options.operationId) await restoreOperationOrigin(config.workspace, workspace.path)
      if (!codeDelivery) await prepareMissionSkills(config.workspace, workspace.path)
      const now = new Date().toISOString()
      mission = {
        id,
        repositoryRoot: config.workspace,
        goal,
        workspace,
        chiefId: config.chiefId,
        technicalLeadId: config.technicalLeadId,
        designLeadId: config.designLeadId,
        marketingLeadId: config.marketingLeadId,
        personas: config.personas,
        ...(config.availableAgents ? { availableAgents: config.availableAgents } : {}),
        ...(!codeDelivery ? { availableSkills: await discoverMissionSkills(workspace.path) } : { codeDelivery }),
        verifyCommand: config.verifyCommand,
        timeoutSec: config.timeoutSec,
        maxRepairs: config.maxRepairs,
        supervision: { maxRounds: config.maxRounds, rounds: 0, stalledRounds: 0, decisions: [] },
        oma: config.oma,
        operatingPolicy: config.operatingPolicy,
        verificationMode: config.verifyCommand.trim() ? "operator" : "chief",
        executionPolicy: config.executionPolicy,
        ...(codeDelivery ? { execution: { startedAt: now, runsStarted: 0, retries: 0, crashRestarts: 0 } } : {}),
        metricSourcePolicy: config.metricSourcePolicy,
        containerObservationPolicy: operation
          ? operation.containerObservationPolicy
          : config.containerObservationPolicy,
        containerObservation: operation?.containerObservation,
        toolEnvKeys: config.toolEnvKeys,
        capturePolicy: config.capturePolicy,
        status: "pending",
        tasks: [],
        history: [],
        createdAt: now,
        updatedAt: now,
      }
      await store.save(mission)
    }
    console.log(`Order ${id}\nWorkspace: ${mission.workspace.path}\nResume: bun av order --resume ${id}`)
    if (!mission.plan && mission.availableAgents)
      console.log(`Automatic team planning with: ${mission.availableAgents.join(", ")}`)
    const repository = mission.repositoryRoot ?? root
    if (mission.codeDelivery && mission.status === "completed") {
      await runtime.close()
      await deliverMissionCode(mission, store, abortController.signal)
      await saveAndDeliverMissionReport(mission, root)
      reportSaved = true
      return mission
    }
    if (mission.codeDelivery) {
      await prepareMissionSkills(repository, mission.workspace.path)
      await prepareMissionDependencies(repository, mission.workspace.path)
      if (mission.availableSkills === undefined)
        mission.availableSkills = await discoverMissionSkills(mission.workspace.path)
      await store.save(mission)
    }
    if (mission.status !== "completed")
      await prepareChiefToolConfig(await realpath(repository), await realpath(mission.workspace.path))
    if (mission.executionPolicy) {
      const started = Date.parse(executionState(mission).startedAt)
      const remaining = started + mission.executionPolicy.maxDurationSec * 1_000 - Date.now()
      deadlineTimer = setTimeout(
        () =>
          abortController.abort(
            new MissionPause(
              "Mission wall-time limit reached. The Chief retained the unresolved outcome within the saved execution limits.",
              "budget",
            ),
          ),
        Math.max(1, remaining),
      )
    }
    const metrics = createMissionMetricPorts(repository, mission, { signal: abortController.signal })
    const containers = createMissionContainerPorts({ signal: abortController.signal })
    if (mission.metricSourcePolicy && !mission.metricBaselineIds) {
      await metrics.initialize()
      await store.save(mission)
    }
    if (mission.operatingPolicy?.memory || mission.operatingPolicy?.metricTargets?.length) {
      mission.organizationContext = await organizationContext(repository, mission)
      mission.operations ??= {
        runs: [],
        routingEvidence: mission.organizationContext.routeEvidence,
        reviewDecisions: [],
      }
    }
    if (mission.capturePolicy?.enabled && mission.status !== "completed") {
      capture = new MissionCapture(repository, mission.id, mission.capturePolicy)
      await capture.start()
    }
    const ports = runtime.ports()
    const parallel = ports.parallel
    const result = await coordinate(mission, {
      ...ports,
      ...(parallel
        ? {
            parallel: {
              ...parallel,
              prepare: async (current: Mission, taskId: string, attempt: number) => {
                const record = await parallel.prepare(current, taskId, attempt)
                await prepareChiefToolConfig(await realpath(repository), await realpath(record.path))
                return record
              },
            },
          }
        : {}),
      ...(mission.operatingPolicy?.memory || mission.operatingPolicy?.metricTargets?.length
        ? {
            refreshOrganization: mission.metricSourcePolicy
              ? metrics.refreshOrganization
              : (current: Mission) => organizationContext(repository, current),
          }
        : {}),
      ...(mission.metricSourcePolicy ? { observeMetrics: metrics.observeMetrics } : {}),
      ...(mission.containerObservationPolicy?.enabled ? containers : {}),
      runAgent: (actor, prompt, current, stage, context) => {
        capture?.label(`${stage}${context?.taskId ? `:${context.taskId}` : ""}`)
        return ports.runAgent(actor, prompt, current, stage, context)
      },
    })
    await finishCapture()
    if (result.codeDelivery) {
      await runtime.close()
      await deliverMissionCode(result, store, abortController.signal)
    }
    await saveAndDeliverMissionReport(result, root)
    reportSaved = true
    return result
  } catch (error) {
    if (mission && error instanceof Error && /orphan|process marker/.test(error.message)) {
      recordPause(mission, new MissionPause(error.message, "unknown-effect"))
      await store.save(mission)
      return mission
    }
    if (mission?.status === "failed") {
      await finishCapture().catch(() => {})
      if (!reportSaved)
        await saveAndDeliverMissionReport(mission, root).catch((reportError: unknown) =>
          console.error(
            `Could not write the report: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
          ),
        )
      if (!options.worker) printOrderOutcome(mission)
    }
    throw error
  } finally {
    clearTimeout(deadlineTimer)
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", terminate)
    try {
      try {
        await finishCapture()
      } finally {
        try {
          await runtime.close()
        } finally {
          if (mission && isServiceShutdown(abortController.signal)) {
            recordServiceShutdown(mission)
            await store.save(mission)
          }
        }
      }
    } finally {
      await unlock()
    }
  }
}

export interface OrderDispatchDependencies {
  continuous?: typeof runOperation
  single?: typeof runOrder
  supervised?: typeof superviseOrder
}

/** Public orders continue improving by default; persisted record kind controls resume. */
export async function dispatchOrder(
  goal: string | undefined,
  options: ContinuousOptions,
  root = process.cwd(),
  dependencies: OrderDispatchDependencies = {},
): Promise<Mission | ContinuousOperation> {
  assertNotManagedRun()
  root = await realpath(root)
  let single = Boolean(options.once || options.worker || options.missionId || options.baselineWorkspace)
  if (options.resume && !single) {
    const missing = (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    }
    const [operation, mission] = await Promise.all([
      operationStore(root).load(options.resume).catch(missing),
      new MissionStore(join(root, ".agent-valley", "missions")).load(options.resume).catch(missing),
    ])
    if (operation && mission)
      throw new Error(
        `Saved ID ${options.resume} names both an operation and a mission. Use --once to resume the mission; inspect av operations before resuming the operation.`,
      )
    if (!operation && !mission)
      throw new Error(
        `No saved order or operation ${options.resume} was found. Run av missions or av operations and use its recorded ID.`,
      )
    single = Boolean(mission)
  }
  const normalized = Object.fromEntries(
    Object.entries({
      ...options,
      actor: options.actor ?? options.agent,
      director: options.director ?? options.chief,
      actors: options.actors ?? options.personas,
    }).filter(([key, value]) => value !== undefined && !["agent", "chief", "personas"].includes(key)),
  ) as ContinuousOptions
  if (single) {
    if (normalized.cycles !== undefined || normalized.interval !== undefined)
      throw new Error(
        "--cycles and --interval apply to continuing orders. Omit them when using --once or resuming a single mission.",
      )
    const { once: _once, cycles: _cycles, interval: _interval, ...missionOptions } = normalized
    return missionOptions.worker || missionOptions.supervise === false
      ? (dependencies.single ?? runOrder)(goal, missionOptions, root)
      : (dependencies.supervised ?? superviseOrder)(goal, missionOptions, root)
  }
  if (normalized.supervise === false)
    throw new Error("Continuing orders require supervision. Add --once to run one goal with --no-supervise.")
  if (normalized.retry || normalized.resolveEffect !== undefined || normalized.effectResult !== undefined)
    throw new Error(
      "Resume the saved child mission ID for --retry or external-effect reconciliation. Run av operations to find its current child; the continuing order retains its charter.",
    )
  const {
    once: _once,
    supervise: _supervise,
    worker: _worker,
    missionId: _missionId,
    baselineWorkspace: _baseline,
    ...operationOptions
  } = normalized
  return (dependencies.continuous ?? runOperation)(goal, operationOptions, root)
}

export function registerChiefCommands(program: Command): void {
  registerContinuousCommands(program)
  program
    .command("order [goal]")
    .description("Give the Chief Director a goal; continuously select, execute, review and verify improvements")
    .option("--once", "Stop after one verified goal instead of continuing improvements")
    .option("--cycles <count>", "Cumulative verified improvement limit; default continues until stopped")
    .option("--interval <seconds>", "Wait before selecting again when no new goal is justified (default 300)")
    .option("--workspace <path>", "Target Git repository (defaults to av.yaml)")
    .option("--verify <command>", "Trusted completion check (defaults to av.yaml)")
    .option("--deliver <branch>", "Commit and push only verified, reviewed work to the selected source branch")
    .option("--delivery-paths <json>", "JSON array of exact product files allowed for code delivery")
    .option(
      "--delivery-message <text>",
      "Commit message for the approved delivery, including required repository trailers",
    )
    .option("--delivery-remote <name>", "Configured Git remote for code delivery (default origin)")
    .option("--delivery-skip-pre-push", "Authorize git push --no-verify for this delivery; commit hooks remain enabled")
    .option("--actor <type>", "Chief Director CLI (default: saved actor.type, otherwise an authenticated CLI)")
    .option("--model <id>", "Chief Director model (default: actor.model from config, otherwise the CLI default)")
    .option("--director <id>", "Chief Director Actor ID")
    .option("--actors <file>", "Use a configured YAML Actor roster instead of generating goal-specific Actors")
    .addOption(new Option("--agent <type>", "Legacy alias for --actor").hideHelp())
    .addOption(new Option("--chief <id>", "Legacy alias for --director").hideHelp())
    .addOption(new Option("--personas <file>", "Legacy alias for --actors").hideHelp())
    .option("--oma", "Require OMA completion receipts for workers (installed skill selection is automatic)")
    .option("--timeout <seconds>", "Timeout per actor/check (default 600 or actor.timeout)")
    .option("--repairs <count>", "Repair limit per task/final review (default 2)")
    .option("--rounds <count>", "Chief Director recovery decision limit, preserved on resume (default 8, maximum 50)")
    .option("--parallel <count>", "Independent Actor concurrency (default 3, maximum 8)")
    .option(
      "--runs <count>",
      "Actor call limit per goal/decision; may be increased on saved checkpoint resume (default 200)",
    )
    .option("--duration <seconds>", "Wall-time limit per goal/decision; may be increased on resume (default 86400)")
    .option("--cost <usd>", "Configured-price estimated cost limit; unknown cost pauses further calls")
    .option("--account-run <run-id>", "Reconcile a finished run whose usage/cost was lost")
    .option("--account-cost <usd>", "Operator-observed USD cost for --account-run; stored separately from native usage")
    .option("--retry", "Resume after repairing a blocker; retain prior evidence and spent budget")
    .option("--resolve-effect <task-id>", "Reconcile an interrupted external action before resuming")
    .option("--effect-result <result>", "External destination inspection result: completed or not-applied")
    .option("--no-supervise", "With --once, run directly without worker crash restart or observation polling")
    .option("--service", "Resume after OS service SIGTERM within saved limits; SIGINT still cancels")
    .addOption(new Option("--worker", "Internal supervised worker").hideHelp())
    .addOption(new Option("--mission-id <id>", "Internal mission identity").hideHelp())
    .addOption(new Option("--baseline-workspace <path>", "Internal accepted operation snapshot").hideHelp())
    .addOption(new Option("--operation-id <id>", "Internal operation identity").hideHelp())
    .addOption(new Option("--native-model", "Internal pinned Chief native model default").hideHelp())
    .option("--resume <id>", "Resume the saved continuing order or single mission with its original contract")
    .action(async (goal: string | undefined, options: ContinuousOptions) => {
      const result = await dispatchOrder(goal, options)
      if ("phase" in result) {
        console.log(`Order ${result.id}: ${result.phase}; ${result.completedCycles} verified improvements.`)
        if (result.error) console.error(result.error)
        process.exitCode = result.phase === "paused" ? 2 : 0
      } else {
        if (!options.worker) printOrderOutcome(result)
        process.exitCode = orderExitCode(result)
      }
    })

  registerMissionCommands(program)
}
