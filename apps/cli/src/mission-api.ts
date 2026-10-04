import { randomUUID } from "node:crypto"
import { lstat, readdir, realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { renderReport } from "@agent-valley/core/chief/reports"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { type OrderOptions, resolveOrderConfig } from "./chief-config"
import { applyResumeOptions, validateResumeOptions } from "./chief-resume"
import { assertNotManagedRun } from "./managed-run"
import {
  type McpOrderInput,
  type McpReportResult,
  type McpResumeInput,
  type MissionApiPort,
  mcpOrderSchema,
  mcpResumeSchema,
  missionIdSchema,
} from "./mcp-contract"
import { digest, ensureAvDirectory, type JobLiveness, jobLiveness, type MissionJob, MissionJobs } from "./mission-jobs"
import { launchMission, type MissionLaunch } from "./mission-launcher"

export interface MissionApiDependencies {
  launch?: (input: MissionLaunch) => Promise<{ pid: number; identity?: string }>
  liveness?: (job: MissionJob) => JobLiveness
  signal?: (pid: number) => void
  validateOrder?: (workspace: string, options: OrderOptions) => Promise<unknown>
  env?: NodeJS.ProcessEnv
}

function orderOptions(input: McpOrderInput | McpResumeInput): OrderOptions {
  const options: OrderOptions = {}
  for (const key of ["runs", "duration", "cost"] as const)
    if (input[key] !== undefined) options[key] = String(input[key])
  if ("missionId" in input) {
    options.resume = input.missionId
    options.retry = input.retry
    if (input.rounds !== undefined) options.rounds = String(input.rounds)
  } else {
    options.verify = input.verify
    if (input.parallel !== undefined) options.parallel = String(input.parallel)
  }
  return options
}

function launchArgs(goal: string | undefined, options: OrderOptions, missionId: string): string[] {
  // Always terminate option parsing before a caller-controlled goal.
  const args = ["order"]
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === false) continue
    args.push(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
    if (value !== true) args.push(String(value))
  }
  if (!options.resume) args.push("--mission-id", missionId)
  if (goal !== undefined) args.push("--", goal)
  return args
}

function missionSummary(mission: Mission): Record<string, unknown> {
  return {
    missionId: mission.id,
    status: mission.status,
    goal: mission.goal,
    workspace: mission.workspace.path,
    branch: mission.workspace.branch,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
    tasks: mission.tasks.map((task) => ({ id: task.id, status: task.status })),
    error: mission.error,
    execution: mission.execution,
    executionPolicy: mission.executionPolicy,
  }
}

/** Durable asynchronous control plane shared by CLI clients and MCP transports. */
export class MissionApi implements MissionApiPort {
  private readonly store: MissionStore
  private readonly jobs: MissionJobs
  private submissions: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(
    private readonly projectRoot: string,
    private readonly workspace: string,
    private readonly dependencies: MissionApiDependencies,
  ) {
    this.store = new MissionStore(join(projectRoot, ".agent-valley/missions"))
    this.jobs = new MissionJobs(projectRoot)
  }

  static async create(workspace: string, dependencies: MissionApiDependencies = {}): Promise<MissionApi> {
    if (!isAbsolute(workspace)) throw new Error("Set an absolute Git repository path in av mcp --workspace <path>.")
    const projectRoot = await realpath(workspace)
    const target = loadProjectConfig(projectRoot)?.workspace?.root ?? projectRoot
    if (!isAbsolute(target)) throw new Error("Set workspace.root in av.yaml to an absolute Git repository path.")
    return new MissionApi(projectRoot, await realpath(target), dependencies)
  }

  get targetWorkspace(): string {
    return this.workspace
  }

  async order(raw: McpOrderInput): Promise<Record<string, unknown>> {
    assertNotManagedRun(this.dependencies.env)
    const input = mcpOrderSchema.parse(raw)
    if (input.workspace && (!isAbsolute(input.workspace) || (await realpath(input.workspace)) !== this.workspace))
      throw new Error(
        "This AV server is bound to another workspace. Start av mcp --workspace for the target repository.",
      )
    const options = { ...orderOptions(input), workspace: this.workspace }
    return this.submit("order", input, options, randomUUID(), input.goal)
  }

  async resume(raw: McpResumeInput): Promise<Record<string, unknown>> {
    assertNotManagedRun(this.dependencies.env)
    const input = mcpResumeSchema.parse(raw)
    return this.submit("resume", input, orderOptions(input), input.missionId)
  }

  async list(): Promise<Record<string, unknown>> {
    this.assertOpen()
    await ensureAvDirectory(this.projectRoot, ["missions"])
    const ids = new Set(
      (await readdir(join(this.projectRoot, ".agent-valley/missions")))
        .filter((name) => name.endsWith(".json"))
        .map((name) => missionIdSchema.parse(name.slice(0, -5))),
    )
    for (const job of await this.jobs.list()) ids.add(job.missionId)
    return {
      workspace: this.workspace,
      project: this.projectRoot,
      missions: await Promise.all([...ids].map((id) => this.status(id))),
    }
  }

  async status(id: string): Promise<Record<string, unknown>> {
    this.assertOpen()
    missionIdSchema.parse(id)
    const mission = await this.load(id)
    const job = await this.jobs.latest(id)
    if (!mission && !job) throw new Error(`Mission ${id} was not found in this workspace. Use av_missions first.`)
    const supervisor = job ? (this.dependencies.liveness ?? jobLiveness)(job) : undefined
    return {
      ...(mission
        ? missionSummary(mission)
        : { missionId: id, goal: job?.goal, status: this.launchStatus(job as MissionJob, supervisor) }),
      repositoryRoot: mission?.repositoryRoot ?? this.workspace,
      ...(job
        ? {
            requestId: job.requestId,
            launch: job.phase,
            supervisor,
            cancelRequestedAt: job.cancelRequestedAt,
            launchError: job.error,
          }
        : {}),
      ...(mission
        ? {
            verification: mission.verification,
            goalVerification: mission.goalVerification,
            finalReview: mission.finalReview,
          }
        : {}),
    }
  }

  async report(id: string): Promise<McpReportResult> {
    this.assertOpen()
    const mission = await this.load(missionIdSchema.parse(id))
    if (!mission)
      throw new Error(`Mission ${id} has no saved report yet. Inspect av_status and retry after initialization.`)
    return { missionId: id, status: mission.status, markdown: renderReport(mission), capture: mission.capture }
  }

  async cancel(id: string): Promise<Record<string, unknown>> {
    missionIdSchema.parse(id)
    return this.serialized(async () => {
      const mission = await this.load(id)
      const job = await this.jobs.latest(id)
      if (mission && ["completed", "failed", "paused"].includes(mission.status)) return this.status(id)
      if (!job)
        throw new Error("This mission has no AV API launch receipt. Stop its original av order process to cancel it.")
      const liveness = (this.dependencies.liveness ?? jobLiveness)(job)
      if (liveness === "unknown")
        throw new Error(
          "Supervisor identity is unavailable. Inspect the original process before stopping or retrying this mission.",
        )
      if (liveness === "running" && job.pid) {
        job.cancelRequestedAt = new Date().toISOString()
        await this.jobs.save(job)
        const current = (this.dependencies.liveness ?? jobLiveness)(job)
        if (current === "unknown")
          throw new Error(
            "Supervisor identity changed during cancellation. Inspect the original process; no signal was sent.",
          )
        if (current === "stopped") return { ...(await this.status(id)), cancelRequested: false }
        ;(this.dependencies.signal ?? ((pid) => process.kill(pid, "SIGTERM")))(job.pid)
      }
      return { ...(await this.status(id)), cancelRequested: liveness === "running" }
    })
  }

  async close(): Promise<void> {
    await this.submissions.catch(() => {})
    this.closed = true
  }

  private submit(
    kind: "order" | "resume",
    input: McpOrderInput | McpResumeInput,
    options: OrderOptions,
    id: string,
    goal?: string,
  ): Promise<Record<string, unknown>> {
    return this.serialized(async () => {
      const requestId = input.requestId ?? randomUUID()
      const { requestId: _unused, ...content } = input
      const inputHash = digest(JSON.stringify({ kind, ...content }))
      const existing = await this.jobs.findRequest(requestId)
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new Error(
            "requestId already belongs to different inputs. Reuse the original inputs or choose a new requestId.",
          )
        return { ...(await this.status(existing.missionId)), accepted: existing.phase !== "failed", replayed: true }
      }
      const previous = await this.jobs.latest(id)
      if (previous && (this.dependencies.liveness ?? jobLiveness)(previous) !== "stopped")
        throw new Error(
          "This mission already has an active or uncertain supervisor. Use av_status or cancel the existing run before resuming.",
        )
      if (kind === "order") await (this.dependencies.validateOrder ?? resolveOrderConfig)(this.projectRoot, options)
      else {
        const mission = await this.load(id)
        if (!mission) throw new Error(`Mission ${id} was not found in this workspace. Use av_missions first.`)
        if (mission.status === "completed")
          throw new Error("This mission is already completed. Create a new order for additional work.")
        validateResumeOptions(undefined, options)
        applyResumeOptions(structuredClone(mission), undefined, options)
        if (mission.repositoryRoot && (await realpath(mission.repositoryRoot)) !== this.workspace)
          throw new Error("The saved mission belongs to another repository. Connect to its workspace before resuming.")
        const unlock = await this.store.lock(id)
        await unlock()
      }
      const job: MissionJob = {
        version: 1,
        requestId,
        inputHash,
        missionId: id,
        kind,
        phase: "prepared",
        goal,
        createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString(),
      }
      await this.jobs.save(job)
      try {
        const child = await (this.dependencies.launch ?? launchMission)({
          args: launchArgs(goal, options, id),
          workspace: this.projectRoot,
          logPath: this.jobs.logPath(job),
        })
        Object.assign(job, child, { phase: "started" })
        await this.jobs.save(job)
      } catch (error) {
        // Once spawn may have happened, retain uncertainty instead of allowing duplicate work.
        if (job.phase !== "started") {
          job.phase = "failed"
          job.error =
            "Supervisor launch failed. Inspect its private launch log and submit a new requestId after fixing the environment."
          await this.jobs.save(job)
        }
        throw error
      }
      return { ...(await this.status(id)), accepted: true, replayed: false }
    })
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.submissions.then(() => this.jobs.locked(operation))
    this.submissions = result.catch(() => {})
    return result
  }

  private async load(id: string): Promise<Mission | undefined> {
    await ensureAvDirectory(this.projectRoot, ["missions"])
    try {
      const path = join(this.projectRoot, ".agent-valley/missions", `${missionIdSchema.parse(id)}.json`)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Mission record must be a regular file: ${path}. Remove the symlink before retrying.`)
      return await this.store.load(id)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }

  private launchStatus(job: MissionJob, supervisor?: JobLiveness): string {
    if (job.phase === "failed" || supervisor === "stopped") return "failed-to-start"
    return job.phase === "prepared" ? "launch-uncertain" : "starting"
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("AV API connection is closed. Reconnect and query the saved mission ID.")
  }
}
