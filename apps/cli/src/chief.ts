import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { aggregateProviderHealth } from "@agent-valley/core/chief/actor-health"
import { seedProviderHealthEvidence } from "@agent-valley/core/chief/actor-health-seed"
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
import { seedWorkspaceCaches, siblingMissionWorkspaces } from "@agent-valley/core/chief/workspace-cache"
import { ensureRuntimeGitignore } from "@agent-valley/core/workspace/runtime-ignore"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { discoverReadyAgents, resetHandoffForRetry } from "./chief-agent-discovery"
import { deliverMissionCode, prepareCodeDelivery } from "./chief-code-delivery"
import { deliveryPaths, type OrderOptions, resolveOrderConfig } from "./chief-config"
import { createMissionContainerPorts } from "./chief-containers"
import { type ContinuousOptions, operationStore, restoreOperationOrigin, runOperation } from "./chief-continuous"
import { saveAndDeliverMissionReport } from "./chief-delivery"
import { enableMissionDelivery } from "./chief-delivery-resume"
import { discoverFreeModels } from "./chief-free-model-discovery"
import { createMissionMetricPorts } from "./chief-metrics"
import { printOrderOutcome } from "./chief-outcome"
import { resumeParentForChild } from "./chief-parent-resume"
import { applyResumeOptions, validateResumeOptions } from "./chief-resume"
import { superviseOrder } from "./chief-supervisor"
import { prepareChiefToolConfig } from "./chief-tool-config"
import { prepareMissionDependencies } from "./chief-workspace-dependencies"
import { assertNotManagedRun } from "./managed-run"

async function organizationContext(repository: string, mission: Mission) {
  const context = await loadOrganizationContext(
    repository,
    mission.goal,
    mission.operatingPolicy?.metricTargets,
    mission.operatingPolicy?.routing?.evidenceWindow,
  )
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
    !options.resume &&
    [options.retry, options.resolveEffect, options.effectResult, options.accountRun, options.accountCost].some(
      (value) => value !== undefined && value !== false,
    )
  )
    throw new Error("Use --resume <id> for retry, external-effect resolution or cost reconciliation.")
  await ensureRuntimeGitignore(root)
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
  const runtime = new ChiefRuntime(
    store,
    abortController.signal,
    (stage, persona) => console.log(`[${stage}] ${persona.name} (${persona.agentType})`),
    undefined,
    undefined,
    discoverReadyAgents,
    discoverFreeModels,
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
      await ensureRuntimeGitignore(mission.repositoryRoot ?? root)
      applyResumeOptions(mission, goal, options)
      resetHandoffForRetry(mission, options.retry)
      await store.save(mission)
      await store.recoverProcesses(id, mission)
      await enableMissionDelivery(mission, options, store)
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
      await ensureRuntimeGitignore(config.workspace)
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
      if (options.operationId) {
        await restoreOperationOrigin(config.workspace, workspace.path)
        // A new child starts from the previous child's build cache instead of compiling from nothing.
        await seedWorkspaceCaches({
          workspace: workspace.path,
          sources: await siblingMissionWorkspaces(workspace.path),
        })
      }
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
        ...(operation?.actorHealth?.length
          ? {
              operations: {
                runs: [],
                routingEvidence: seedProviderHealthEvidence([], operation.actorHealth),
                reviewDecisions: [],
              },
            }
          : {}),
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
      if (!options.resume && mission.operations)
        mission.operations.routingEvidence = seedProviderHealthEvidence(
          mission.organizationContext.routeEvidence,
          aggregateProviderHealth(mission),
        )
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
    if (
      normalized.cycles !== undefined ||
      normalized.interval !== undefined ||
      normalized.sourceIntegration !== undefined ||
      normalized.charterAppend !== undefined ||
      normalized.charterSupersede !== undefined
    )
      throw new Error(
        "--cycles, --interval, --source-integration and charter amendments apply to continuing orders. Omit them when using --once or resuming a single mission.",
      )
    const {
      once: _once,
      cycles: _cycles,
      interval: _interval,
      charterAppend: _charterAppend,
      charterSupersede: _charterSupersede,
      ...missionOptions
    } = normalized
    const result = await (missionOptions.worker || missionOptions.supervise === false
      ? (dependencies.single ?? runOrder)(goal, missionOptions, root)
      : (dependencies.supervised ?? superviseOrder)(goal, missionOptions, root))
    return options.resume && !options.once && !missionOptions.worker && missionOptions.supervise !== false
      ? resumeParentForChild(root, result, (id) =>
          (dependencies.continuous ?? runOperation)(undefined, { resume: id }, root),
        )
      : result
  }
  if (normalized.supervise === false)
    throw new Error("Continuing orders require supervision. Add --once to run one goal with --no-supervise.")
  if (normalized.retry && !normalized.resume)
    throw new Error("Use --resume <operation-id> with --retry to retry a saved continuing order.")
  if (normalized.resolveEffect !== undefined || normalized.effectResult !== undefined)
    throw new Error(
      "Resume the saved child mission ID for external-effect reconciliation. Run av operations to find its current child; the continuing order retains its charter.",
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
