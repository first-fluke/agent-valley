import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { MissionCapture } from "@agent-valley/core/chief/capture"
import { createContinuousMissionWorkspace } from "@agent-valley/core/chief/continuous-workspace"
import { coordinate } from "@agent-valley/core/chief/coordinator"
import { executionState, MissionPause, recordPause } from "@agent-valley/core/chief/execution"
import { loadOrganizationContext } from "@agent-valley/core/chief/organization"
import { ChiefRuntime, missionIssue } from "@agent-valley/core/chief/runtime"
import { discoverMissionSkills, prepareMissionSkills } from "@agent-valley/core/chief/skills"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import { type Command, Option } from "commander"
import { type OrderOptions, resolveOrderConfig } from "./chief-config"
import { registerContinuousCommands, restoreOperationOrigin } from "./chief-continuous"
import { saveAndDeliverMissionReport } from "./chief-delivery"
import { createMissionMetricPorts } from "./chief-metrics"
import { orderExitCode, printOrderOutcome } from "./chief-outcome"
import { applyResumeOptions, validateResumeOptions } from "./chief-resume"
import { abortableDelay, superviseOrder } from "./chief-supervisor"
import { prepareChiefToolConfig } from "./chief-tool-config"
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
  const runtime = new ChiefRuntime(store, abortController.signal, (stage, persona) =>
    console.log(`[${stage}] ${persona.name} (${persona.agentType})`),
  )
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
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
      await store.recoverProcesses(id)
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
          : await new WorkspaceManager(config.workspace).create(missionIssue(id, goal))
      if (options.operationId) await restoreOperationOrigin(config.workspace, workspace.path)
      await prepareMissionSkills(config.workspace, workspace.path)
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
        availableSkills: await discoverMissionSkills(workspace.path),
        verifyCommand: config.verifyCommand,
        timeoutSec: config.timeoutSec,
        maxRepairs: config.maxRepairs,
        supervision: { maxRounds: config.maxRounds, rounds: 0, stalledRounds: 0, decisions: [] },
        oma: config.oma,
        operatingPolicy: config.operatingPolicy,
        verificationMode: config.verifyCommand.trim() ? "operator" : "chief",
        executionPolicy: config.executionPolicy,
        metricSourcePolicy: config.metricSourcePolicy,
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
    if (mission.status !== "completed")
      await prepareChiefToolConfig(await realpath(repository), await realpath(mission.workspace.path))
    if (mission.executionPolicy) {
      const started = Date.parse(executionState(mission).startedAt)
      const remaining = started + mission.executionPolicy.maxDurationSec * 1_000 - Date.now()
      deadlineTimer = setTimeout(
        () =>
          abortController.abort(
            new MissionPause(
              "Mission wall-time limit reached. Increase --duration on resume to continue the original goal.",
              "budget",
            ),
          ),
        Math.max(1, remaining),
      )
    }
    const metrics = createMissionMetricPorts(repository, mission, { signal: abortController.signal })
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
      runAgent: (actor, prompt, current, stage, context) => {
        capture?.label(`${stage}${context?.taskId ? `:${context.taskId}` : ""}`)
        return ports.runAgent(actor, prompt, current, stage, context)
      },
    })
    await finishCapture()
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
    process.removeListener("SIGTERM", interrupt)
    try {
      try {
        await finishCapture()
      } finally {
        await runtime.close()
      }
    } finally {
      await unlock()
    }
  }
}

export function registerChiefCommands(program: Command): void {
  registerContinuousCommands(program)
  program
    .command("order [goal]")
    .description("Give the Chief Director a goal; delegate Actors, review, repair and verify in an isolated worktree")
    .option("--workspace <path>", "Target Git repository (defaults to av.yaml)")
    .option("--verify <command>", "Trusted completion check (defaults to av.yaml)")
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
    .option("--runs <count>", "Total Actor call limit; may be increased on resume (default 200)")
    .option("--duration <seconds>", "Mission wall-time limit; may be increased on resume (default 86400)")
    .option("--cost <usd>", "Configured-price estimated cost limit; unknown cost pauses further calls")
    .option("--account-run <run-id>", "Reconcile a finished run whose usage/cost was lost")
    .option("--account-cost <usd>", "Operator-observed USD cost for --account-run; stored separately from native usage")
    .option("--retry", "Resume after repairing a blocker; retain prior evidence and spent budget")
    .option("--resolve-effect <task-id>", "Reconcile an interrupted external action before resuming")
    .option("--effect-result <result>", "External destination inspection result: completed or not-applied")
    .option("--no-supervise", "Run directly without worker crash restart or scheduled observation polling")
    .addOption(new Option("--worker", "Internal supervised worker").hideHelp())
    .addOption(new Option("--mission-id <id>", "Internal mission identity").hideHelp())
    .addOption(new Option("--baseline-workspace <path>", "Internal accepted operation snapshot").hideHelp())
    .addOption(new Option("--operation-id <id>", "Internal operation identity").hideHelp())
    .addOption(new Option("--native-model", "Internal pinned Chief native model default").hideHelp())
    .option("--resume <id>", "Resume a saved order with its original acceptance contract")
    .action(async (goal: string | undefined, options: OrderOptions) => {
      const mission =
        options.worker || options.supervise === false
          ? await runOrder(goal, options)
          : await superviseOrder(goal, options, process.cwd())
      if (!options.worker) printOrderOutcome(mission)
      process.exitCode = orderExitCode(mission)
    })

  program
    .command("missions")
    .description("List saved Chief Director orders and their workspaces")
    .option("--watch", "Resume due or interrupted orders from their saved checkpoints")
    .action(async (options: { watch?: boolean }) => {
      if (options.watch) {
        assertNotManagedRun()
        const controller = new AbortController()
        const stop = () => controller.abort()
        process.once("SIGINT", stop)
        process.once("SIGTERM", stop)
        try {
          while (!controller.signal.aborted) {
            const store = new MissionStore(join(process.cwd(), ".agent-valley/missions"))
            for (const mission of await store.list()) {
              if (controller.signal.aborted) break
              if (["completed", "failed", "paused"].includes(mission.status) || !mission.executionPolicy?.autoResume)
                continue
              if (mission.execution?.nextRunAt && Date.parse(mission.execution.nextRunAt) > Date.now()) continue
              await superviseOrder(undefined, { resume: mission.id }, process.cwd(), {
                signal: controller.signal,
              })
                .then(printOrderOutcome)
                .catch((error: unknown) => console.error(String(error)))
            }
            await abortableDelay(5_000, controller.signal)
          }
        } catch (error) {
          if (!controller.signal.aborted) throw error
        } finally {
          process.removeListener("SIGINT", stop)
          process.removeListener("SIGTERM", stop)
        }
        return
      }
      const missions = await new MissionStore(join(process.cwd(), ".agent-valley/missions")).list()
      if (!missions.length) console.log("No orders yet. Run bun av order --help.")
      for (const mission of missions) {
        console.log(
          `${mission.id}  ${mission.status}  ${mission.tasks.filter((task) => task.status === "completed").length}/${mission.tasks.length}  ${mission.goal.slice(0, 100)}`,
        )
        console.log(`  ${mission.workspace.path}${mission.error ? `\n  ${mission.error}` : ""}`)
      }
    })
}
