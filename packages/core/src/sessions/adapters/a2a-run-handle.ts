import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { RunAttempt } from "../../domain/models"
import {
  AgentRunError,
  type AgentRunEvent,
  type ExecutionCapabilities,
  type InterventionCommand,
  InterventionUnsupportedError,
  type RunHandle,
  type SpawnInput,
  type Unsubscribe,
} from "../../domain/ports/agent-runner"
import { RunHandleEmitter } from "../../util/run-handle-events"
import { type A2aClient, A2aClientError } from "./a2a-client"
import {
  type A2aCheckpoint,
  type A2aLifecycle,
  type A2aSendResponse,
  type A2aTask,
  a2aCheckpointSchema,
  a2aRequestSha256,
  a2aSendResponseSchema,
  a2aTaskSchema,
  isA2aTerminal,
} from "./a2a-contracts"

export class A2aRunHandle implements RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  readonly result: Promise<RunAttempt>
  readonly executionCapabilities: ExecutionCapabilities = {
    cancellation: "confirmed",
    forceStop: false,
    reconnect: true,
  }
  private readonly emitter = new RunHandleEmitter()
  private readonly pollAbort = new AbortController()
  private readonly attempt: RunAttempt
  private readonly deadline: number
  private checkpoint?: A2aCheckpoint
  private cancelled = false
  private timedOut = false
  private alive = true
  private remotePossible = false
  private terminal = false
  private failure?: AgentRunError
  private finished: Promise<void> = Promise.resolve()
  private resolveResult!: (result: RunAttempt) => void
  private rejectResult!: (error: AgentRunError) => void
  private readonly abort = () => {
    void this.cancel().catch(() => {})
  }

  constructor(
    private readonly input: SpawnInput,
    private readonly client: A2aClient,
    private readonly lifecycle: A2aLifecycle,
  ) {
    this.attemptId = input.attemptId
    this.issueKey = input.issue.identifier
    this.attempt = input.attempt ?? {
      id: input.attemptId,
      issueId: input.issue.id,
      workspacePath: resolve(input.workspace.path),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }
    this.deadline = Date.now() + (input.timeoutMs ?? 3_600_000)
    this.result = new Promise((resolveResult, rejectResult) => {
      this.resolveResult = resolveResult
      this.rejectResult = rejectResult
    })
    void this.result.catch(() => {})
  }

  start(): void {
    this.input.signal?.addEventListener("abort", this.abort, { once: true })
    this.cancelled = this.input.signal?.aborted ?? false
    this.emitter.emit({ kind: "started", attemptId: this.attemptId })
    this.finished = Promise.resolve()
      .then(() => this.execute())
      .then(
        (result) => {
          this.alive = false
          this.resolveResult(result)
          this.emitter.emit({ kind: "complete", attemptId: this.attemptId, exitCode: result.exitCode })
        },
        async (error: unknown) => {
          this.failure = this.executionError(error)
          if (this.failure.outcomeUnknown && this.checkpoint) {
            try {
              await this.persist({ ...this.checkpoint, phase: "unknown" })
            } catch {
              /* Prior submission checkpoint remains a replay barrier. */
            }
          }
          this.alive = false
          this.rejectResult(this.failure)
          this.emitter.emit({ kind: "error", attemptId: this.attemptId, error: this.failure })
        },
      )
      .finally(() => this.input.signal?.removeEventListener("abort", this.abort))
  }

  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe {
    return this.emitter.subscribe(handler)
  }
  isAlive(): boolean {
    return this.alive
  }

  async send(command: InterventionCommand): Promise<void> {
    if (command.kind !== "abort") throw new InterventionUnsupportedError(command.kind, this.input.agentType)
    return this.cancel()
  }

  async kill(): Promise<void> {
    throw new Error("A2A does not support force stop. Request cancellation and reconcile its terminal task state.")
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    this.pollAbort.abort()
    await this.finished
    if (this.failure?.outcomeUnknown) throw this.failure
  }

  private async execute(): Promise<RunAttempt> {
    let response: A2aSendResponse
    try {
      response = await this.initialize()
    } catch (error) {
      if (Date.now() >= this.deadline && this.checkpoint?.taskId && this.remotePossible) {
        this.timedOut = true
        this.cancelled = true
        return this.cancelRemote()
      }
      throw error
    }
    while (true) {
      if (this.cancelled) return this.cancelRemote()
      if (response.message) {
        if (response.message.role !== "ROLE_AGENT" || !response.message.contextId)
          throw this.unknown("A2A returned an invalid agent message. Reconcile the dispatched execution.")
        if (response.message.taskId) {
          await this.persist({
            ...this.requiredCheckpoint(),
            phase: "accepted",
            taskId: response.message.taskId,
            contextId: response.message.contextId,
          })
          const polled = await this.pollTask()
          if (polled) response = { task: polled }
          continue
        }
        this.terminal = true
        await this.persist({ ...this.requiredCheckpoint(), phase: "terminal", contextId: response.message.contextId })
        return this.complete(response)
      }
      if (!response.task) throw this.unknown("A2A omitted its task or message. Reconcile the dispatched execution.")
      const task = response.task
      await this.observe(task)
      if (isA2aTerminal(task.status.state)) {
        if (task.status.state !== "TASK_STATE_COMPLETED") throw this.terminalFailure(task)
        return this.complete({ task })
      }
      if (
        ["TASK_STATE_INPUT_REQUIRED", "TASK_STATE_AUTH_REQUIRED", "TASK_STATE_UNSPECIFIED"].includes(task.status.state)
      )
        throw this.unknown(
          `A2A task ${task.id} is ${task.status.state}. Reconcile the task or supply the required authorization/input before resuming.`,
        )
      if (Date.now() >= this.deadline) {
        this.timedOut = true
        this.cancelled = true
        continue
      }
      await this.pause()
      if (this.cancelled) continue
      if (Date.now() >= this.deadline) {
        this.timedOut = true
        this.cancelled = true
        continue
      }
      const polled = await this.pollTask()
      if (polled) response = { task: polled }
    }
  }

  private async initialize(): Promise<A2aSendResponse> {
    let saved: A2aCheckpoint | undefined
    try {
      saved = await this.lifecycle.load()
    } catch {
      throw this.unknown("A2A execution checkpoint could not be read. Restore durable storage before reconnecting.")
    }
    const endpoint = this.client.endpoint
    const digest = a2aRequestSha256(this.input, endpoint)
    if (saved) {
      const parsed = a2aCheckpointSchema.safeParse(saved)
      if (
        !parsed.success ||
        saved.endpointId !== endpoint.id ||
        saved.endpointUrl !== new URL(endpoint.url).href ||
        saved.attemptId !== this.attemptId ||
        saved.requestSha256 !== digest ||
        saved.tenant !== endpoint.tenant
      )
        throw this.unknown(
          "A2A checkpoint differs from the saved request or endpoint. Restore the original execution input; do not submit it again.",
        )
      this.checkpoint = parsed.data
      this.remotePossible = saved.phase !== "prepared"
      if (saved.taskId && ["accepted", "terminal", "unknown"].includes(saved.phase)) {
        if (this.cancelled) return { task: await this.getTask() }
        await this.client.validateCard(this.executionSignal())
        return { task: await this.getTask(this.executionSignal()) }
      }
      if (saved.phase !== "prepared" || saved.taskId)
        throw this.unknown(
          "A2A submission has no reconnectable remote task ID. Inspect the remote destination and reconcile it; SendMessage will not be repeated.",
        )
    } else {
      await this.persist({
        version: 1,
        endpointId: endpoint.id,
        endpointUrl: new URL(endpoint.url).href,
        attemptId: this.attemptId,
        messageId: randomUUID(),
        requestSha256: digest,
        phase: "prepared",
        ...(endpoint.tenant ? { tenant: endpoint.tenant } : {}),
      })
    }
    if (this.cancelled) throw this.cancelledError()
    await this.client.validateCard(this.executionSignal())
    if (this.cancelled) throw this.cancelledError()
    if (Date.now() >= this.deadline) {
      this.timedOut = true
      throw this.cancelledError()
    }
    await this.persist({ ...this.requiredCheckpoint(), phase: "submitting" })
    this.remotePossible = true
    let raw: unknown
    try {
      raw = await this.client.rpc(
        "SendMessage",
        {
          message: {
            messageId: this.requiredCheckpoint().messageId,
            role: "ROLE_USER",
            parts: [{ text: this.input.prompt }],
            metadata: { agentValley: { attemptId: this.attemptId, requestSha256: digest } },
          },
          configuration: {
            returnImmediately: true,
            historyLength: 0,
            acceptedOutputModes: ["application/json", "text/plain"],
          },
        },
        AbortSignal.timeout(Math.max(1, this.deadline - Date.now())),
      )
    } catch (error) {
      if (error instanceof A2aClientError && error.rejectionConfirmed) {
        this.remotePossible = false
        await this.persist({ ...this.requiredCheckpoint(), phase: "prepared" })
      }
      throw error
    }
    const parsed = a2aSendResponseSchema.safeParse(raw)
    if (!parsed.success)
      throw this.unknown("A2A SendMessage response is invalid. Reconcile the submitted execution before retrying.")
    if (parsed.data.task) await this.observe(parsed.data.task)
    return parsed.data
  }

  private async getTask(signal?: AbortSignal): Promise<A2aTask> {
    const id = this.requiredCheckpoint().taskId
    if (!id) throw this.unknown("A2A execution has no task ID. Inspect the remote destination before resuming.")
    const parsed = a2aTaskSchema.safeParse(await this.client.rpc("GetTask", { id, historyLength: 0 }, signal))
    if (!parsed.success) throw this.unknown("A2A GetTask response is invalid. Restore task visibility before resuming.")
    this.assertTask(parsed.data)
    return parsed.data
  }

  private async pollTask(): Promise<A2aTask | undefined> {
    try {
      return await this.getTask(this.executionSignal())
    } catch (error) {
      if (Date.now() >= this.deadline) {
        this.timedOut = true
        this.cancelled = true
      }
      if (!this.cancelled) throw error
      return undefined
    }
  }

  private assertTask(task: A2aTask): void {
    const checkpoint = this.requiredCheckpoint()
    if (
      (checkpoint.taskId && task.id !== checkpoint.taskId) ||
      (checkpoint.contextId && task.contextId && task.contextId !== checkpoint.contextId)
    )
      throw this.unknown(
        "A2A task identity or context differs from the accepted execution. Reconcile the original task before continuing.",
      )
  }

  private async observe(task: A2aTask): Promise<void> {
    this.assertTask(task)
    this.remotePossible = true
    this.terminal = isA2aTerminal(task.status.state)
    await this.persist({
      ...this.requiredCheckpoint(),
      phase: this.terminal ? "terminal" : "accepted",
      taskId: task.id,
      ...(task.contextId ? { contextId: task.contextId } : {}),
      state: task.status.state,
    })
  }

  private async complete(response: A2aSendResponse): Promise<RunAttempt> {
    const result = await this.lifecycle.complete(response, this.requiredCheckpoint())
    if (
      result.id !== this.attemptId ||
      result.issueId !== this.attempt.issueId ||
      resolve(result.workspacePath) !== resolve(this.attempt.workspacePath) ||
      !result.finishedAt ||
      !Number.isFinite(Date.parse(result.finishedAt)) ||
      Date.parse(result.finishedAt) < Date.parse(this.attempt.startedAt) ||
      result.exitCode !== 0
    )
      throw this.unknown(
        "A2A completion gate returned mismatched or incomplete execution evidence. Reconcile the saved artifacts before continuing.",
      )
    if (result.agentOutput) this.emitter.emit({ kind: "output", attemptId: this.attemptId, text: result.agentOutput })
    return result
  }

  private async cancelRemote(): Promise<never> {
    if (!this.remotePossible) throw this.cancelledError()
    if (!this.requiredCheckpoint().taskId)
      throw this.unknown(
        "A2A submission is uncertain and has no task ID to cancel. Reconcile its remote outcome before resuming.",
      )
    const deadline = Date.now() + (this.client.endpoint.requestTimeoutMs ?? 30_000)
    let task: A2aTask | undefined
    try {
      const parsed = a2aTaskSchema.safeParse(
        await this.client.rpc(
          "CancelTask",
          { id: this.requiredCheckpoint().taskId },
          AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        ),
      )
      if (parsed.success) {
        this.assertTask(parsed.data)
        task = parsed.data
      }
    } catch {
      /* A lost cancel response can be reconciled with an idempotent GetTask. */
    }
    while (true) {
      task ??= await this.getTask(AbortSignal.timeout(Math.max(1, deadline - Date.now())))
      await this.observe(task)
      if (isA2aTerminal(task.status.state)) throw this.cancelledError()
      if (Date.now() >= deadline)
        throw this.unknown(
          "A2A cancellation was not confirmed by a terminal task state. Reconcile the still-active execution before resuming.",
        )
      await this.pause(false, deadline)
      task = await this.getTask(AbortSignal.timeout(Math.max(1, deadline - Date.now())))
    }
  }

  private async persist(checkpoint: A2aCheckpoint): Promise<void> {
    this.checkpoint = checkpoint
    try {
      await this.lifecycle.save(checkpoint)
    } catch {
      throw new AgentRunError(
        "A2A execution checkpoint could not be saved. Restore durable storage and reconcile any submitted task.",
        this.attempt,
        { outcomeUnknown: this.remotePossible },
      )
    }
  }

  private executionSignal(signal = this.pollAbort.signal): AbortSignal {
    return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, this.deadline - Date.now()))])
  }

  private requiredCheckpoint(): A2aCheckpoint {
    if (!this.checkpoint)
      throw this.unknown("A2A execution checkpoint is missing. Restore its durable record before resuming.")
    return this.checkpoint
  }

  private terminalFailure(task: A2aTask): AgentRunError {
    return new AgentRunError(
      `A2A task ${task.id} ended with ${task.status.state}. Inspect its saved evidence before starting another execution.`,
      {
        ...this.attempt,
        finishedAt: new Date().toISOString(),
        exitCode: task.status.state === "TASK_STATE_CANCELED" ? -1 : 1,
      },
      { code: task.status.state === "TASK_STATE_CANCELED" ? "CANCELLED" : "CRASH" },
    )
  }

  private cancelledError(): AgentRunError {
    return new AgentRunError(
      this.timedOut
        ? "A2A execution timed out; any known remote task was confirmed stopped."
        : "A2A execution was cancelled; no new artifacts were applied.",
      { ...this.attempt, finishedAt: new Date().toISOString(), exitCode: null },
      { code: this.timedOut ? "TIMEOUT" : "CANCELLED" },
    )
  }

  private unknown(message: string): AgentRunError {
    return new AgentRunError(message, this.attempt, { outcomeUnknown: true })
  }

  private executionError(error: unknown): AgentRunError {
    if (error instanceof AgentRunError) return error
    if (this.cancelled && !this.remotePossible) return this.cancelledError()
    return new AgentRunError(
      error instanceof A2aClientError
        ? error.message
        : "A2A completion failed. Inspect the saved execution and verification evidence before resuming.",
      this.terminal ? { ...this.attempt, finishedAt: new Date().toISOString(), exitCode: 1 } : this.attempt,
      { outcomeUnknown: this.remotePossible && !this.terminal },
    )
  }

  private async pause(interruptible = true, deadline = this.deadline): Promise<void> {
    const signal = interruptible ? this.pollAbort.signal : undefined
    if (signal?.aborted) return
    await new Promise<void>((resolvePause) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", finish)
        resolvePause()
      }
      const interval = this.client.endpoint.pollIntervalMs ?? 500
      const timer = setTimeout(finish, Math.min(interval, Math.max(1, deadline - Date.now())))
      signal?.addEventListener("abort", finish, { once: true })
    })
  }
}
