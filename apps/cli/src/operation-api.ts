import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { join } from "node:path"
import type { Operation } from "@agent-valley/core/chief/continuous-contract"
import { ContinuousOperationStore } from "@agent-valley/core/chief/continuous-store"
import { resolveOrderConfig } from "./chief-config"
import { renderOperationReport } from "./chief-continuous"
import { assertNotManagedRun } from "./managed-run"
import {
  type McpOperateInput,
  type McpOperationResumeInput,
  type McpOrderInput,
  mcpOperateSchema,
  mcpOperationResumeSchema,
  mcpOrderSchema,
  missionIdSchema,
} from "./mcp-contract"
import type { MissionApiDependencies } from "./mission-api"
import { digest, ensureAvDirectory, jobLiveness, type MissionJob, MissionJobs } from "./mission-jobs"
import { launchMission } from "./mission-launcher"

function summary(operation: Operation): Record<string, unknown> {
  return {
    operationId: operation.id,
    charter: operation.charter,
    status: operation.phase,
    completedCycles: operation.completedCycles,
    cycleLimit: operation.cycleLimit,
    currentMissionId: operation.currentMissionId,
    decisionId: operation.decisionId,
    baselineWorkspace: operation.baseline?.path,
    nextRunAt: operation.nextRunAt,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    error: operation.error,
    history: operation.history,
  }
}

/** Uses the existing detached launcher and identity-checked cancellation, with separate operation receipts. */
export class OperationApi {
  private readonly store: ContinuousOperationStore
  private readonly jobs: MissionJobs
  private submissions: Promise<unknown> = Promise.resolve()
  private closed = false
  constructor(
    private readonly root: string,
    private readonly workspace: string,
    private readonly dependencies: MissionApiDependencies = {},
  ) {
    this.store = new ContinuousOperationStore(join(root, ".agent-valley/operations"))
    this.jobs = new MissionJobs(root, "operation-jobs")
  }
  order(raw: McpOrderInput): Promise<Record<string, unknown>> {
    const input = mcpOrderSchema.parse(raw)
    if (input.once) throw new Error("Use the mission API's order entry with once:true for a single goal.")
    const { goal, once: _once, workspace: _workspace, ...options } = input
    return this.operate({ charter: goal, ...options })
  }
  operate(raw: McpOperateInput): Promise<Record<string, unknown>> {
    assertNotManagedRun(this.dependencies.env)
    const input = mcpOperateSchema.parse(raw)
    return this.submit(input, randomUUID())
  }
  resume(raw: McpOperationResumeInput): Promise<Record<string, unknown>> {
    assertNotManagedRun(this.dependencies.env)
    const input = mcpOperationResumeSchema.parse(raw)
    return this.submit(input, input.operationId)
  }
  async list(): Promise<Record<string, unknown>> {
    this.assertOpen()
    const ids = new Set((await this.store.list()).map((operation) => operation.id))
    for (const job of await this.jobs.list()) ids.add(job.missionId)
    return { workspace: this.workspace, operations: await Promise.all([...ids].map((id) => this.status(id))) }
  }
  async status(id: string): Promise<Record<string, unknown>> {
    this.assertOpen()
    missionIdSchema.parse(id)
    const operation = await this.load(id)
    const job = await this.jobs.latest(id)
    if (!operation && !job) throw new Error(`Operation ${id} was not found. Use av_operations first.`)
    const supervisor = job ? (this.dependencies.liveness ?? jobLiveness)(job) : undefined
    return {
      ...(operation
        ? summary(operation)
        : {
            operationId: id,
            charter: job?.goal,
            status:
              job?.phase === "failed" || supervisor === "stopped"
                ? "failed-to-start"
                : job?.phase === "prepared"
                  ? "launch-uncertain"
                  : "starting",
          }),
      ...(job
        ? { launch: job.phase, supervisor, cancelRequestedAt: job.cancelRequestedAt, launchError: job.error }
        : {}),
    }
  }
  async report(id: string): Promise<Record<string, unknown>> {
    this.assertOpen()
    const operation = await this.load(missionIdSchema.parse(id))
    if (!operation) throw new Error("Operation report is not initialized. Inspect av_operation_status and retry.")
    return { ...summary(operation), markdown: renderOperationReport(operation) }
  }
  cancel(id: string): Promise<Record<string, unknown>> {
    missionIdSchema.parse(id)
    return this.serialized(async () => {
      const operation = await this.load(id)
      const job = await this.jobs.latest(id)
      if (operation && ["completed", "paused"].includes(operation.phase)) return this.status(id)
      if (!job) throw new Error("No API launch receipt exists. Stop the original av order process.")
      const current = (this.dependencies.liveness ?? jobLiveness)(job)
      if (current === "unknown")
        throw new Error("Operation process identity is uncertain. Inspect the original process; no signal was sent.")
      if (current === "running" && job.pid) {
        job.cancelRequestedAt = new Date().toISOString()
        await this.jobs.save(job)
        const checked = (this.dependencies.liveness ?? jobLiveness)(job)
        if (checked === "unknown") throw new Error("Operation process identity changed. No signal was sent.")
        if (checked === "running") (this.dependencies.signal ?? ((pid) => process.kill(pid, "SIGTERM")))(job.pid)
      }
      return { ...(await this.status(id)), cancelRequested: current === "running" }
    })
  }
  async close(): Promise<void> {
    await this.submissions.catch(() => {})
    this.closed = true
  }
  private submit(input: McpOperateInput | McpOperationResumeInput, id: string): Promise<Record<string, unknown>> {
    return this.serialized(async () => {
      const requestId = input.requestId ?? randomUUID()
      const { requestId: _unused, ...content } = input
      const resuming = "operationId" in input
      const inputHash = digest(JSON.stringify({ kind: resuming ? "resume" : "operate", ...content }))
      const existing = await this.jobs.findRequest(requestId)
      if (existing) {
        if (existing.inputHash !== inputHash)
          throw new Error(
            "requestId belongs to different operation inputs. Reuse the original inputs or choose a new requestId.",
          )
        return { ...(await this.status(existing.missionId)), accepted: existing.phase !== "failed", replayed: true }
      }
      const previous = await this.jobs.latest(id)
      if (previous && (this.dependencies.liveness ?? jobLiveness)(previous) !== "stopped")
        throw new Error("Operation has an active or uncertain supervisor. Inspect av_operation_status before resuming.")
      const args = ["order"]
      if (resuming) {
        const operation = await this.load(id)
        if (!operation) throw new Error("Operation was not found. Use av_operations first.")
        if (operation.phase === "completed")
          throw new Error("Operation reached its cycle limit. Start a new charter for more work.")
        const release = await this.store.lock(id)
        await release()
        args.push("--resume", id)
      } else {
        const options = {
          workspace: this.workspace,
          verify: input.verify,
          ...Object.fromEntries(
            ["runs", "duration", "cost", "parallel"].flatMap((key) => {
              const value = input[key as keyof McpOperateInput]
              return value === undefined ? [] : [[key, String(value)]]
            }),
          ),
        }
        await (this.dependencies.validateOrder ?? resolveOrderConfig)(this.root, options)
        args.push("--operation-id", id, "--workspace", this.workspace)
        for (const key of ["cycles", "interval", "verify", "parallel", "runs", "duration", "cost"] as const)
          if (input[key] !== undefined) args.push(`--${key}`, String(input[key]))
        args.push("--", input.charter)
      }
      const job: MissionJob = {
        version: 1,
        requestId,
        inputHash,
        missionId: id,
        kind: resuming ? "resume" : "order",
        phase: "prepared",
        goal: "charter" in input ? input.charter : undefined,
        createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString(),
      }
      await this.jobs.save(job)
      try {
        Object.assign(
          job,
          await (this.dependencies.launch ?? launchMission)({
            args,
            workspace: this.root,
            logPath: this.jobs.logPath(job),
          }),
          { phase: "started" },
        )
        await this.jobs.save(job)
      } catch {
        if (job.phase !== "started") {
          job.phase = "failed"
          job.error =
            "Operation launch failed. Inspect its private launch log and process identity before trying a new request."
          await this.jobs.save(job)
        }
        throw new Error(
          "Operation launch could not be confirmed. Inspect av_operation_status and the launch log before retrying.",
        )
      }
      return { ...(await this.status(id)), accepted: true, replayed: false }
    })
  }
  private async load(id: string): Promise<Operation | undefined> {
    await ensureAvDirectory(this.root, ["operations"])
    try {
      const operation = await this.store.load(id)
      if ((await realpath(operation.repositoryRoot)) !== this.workspace)
        throw new Error("Saved operation belongs to another repository. Connect to its workspace.")
      return operation
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  private serialized<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = this.submissions.then(() => this.jobs.locked(action))
    this.submissions = result.catch(() => {})
    return result
  }
  private assertOpen(): void {
    if (this.closed) throw new Error("AV API connection is closed. Reconnect and inspect the saved operation.")
  }
}
