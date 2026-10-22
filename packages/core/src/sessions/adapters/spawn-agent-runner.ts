/** Local execution adapter. Process identities stay behind this boundary. */
import { capabilitiesFor } from "../../agent-registry"
import { AGENT_IDS } from "../../domain/agent"
import type { RunAttempt } from "../../domain/models"
import type {
  AgentRunEvent,
  AgentRunnerPort,
  ExecutionCapabilities,
  InterventionCapability,
  InterventionCommand,
  RunHandle,
  SpawnInput,
  Unsubscribe,
} from "../../domain/ports/agent-runner"
import { AgentRunError, InterventionUnsupportedError } from "../../domain/ports/agent-runner"
import { AgentRunnerService } from "./agent-runner-service"

export const CAPABILITY_TABLE: Record<string, InterventionCapability[]> = Object.freeze(
  Object.fromEntries(AGENT_IDS.map((id) => [id, capabilitiesFor(id)])),
)

export function defaultCapabilities(agentType: string): InterventionCapability[] {
  return capabilitiesFor(agentType)
}

/** Optional local persistence hooks; neither domain handles nor remote adapters need PIDs. */
export interface LocalRunLifecycle {
  begin(): void | Promise<void>
  spawned(pid: number | undefined): void
  finish(): void | Promise<void>
}

export class SpawnAgentRunnerAdapter implements AgentRunnerPort {
  public readonly service: AgentRunnerService

  constructor(
    service?: AgentRunnerService,
    private readonly lifecycle?: (input: SpawnInput) => LocalRunLifecycle,
  ) {
    this.service = service ?? new AgentRunnerService()
  }

  capabilities(agentType: string): InterventionCapability[] {
    return defaultCapabilities(agentType)
  }

  async spawn(input: SpawnInput): Promise<RunHandle> {
    if (!input.attemptId)
      throw new Error(
        "SpawnAgentRunnerAdapter.spawn: input.attemptId is required. Pass a stable attemptId from the caller.",
      )
    if (!input.agentType)
      throw new Error("SpawnAgentRunnerAdapter.spawn: input.agentType is required. Pass the resolved agent type.")
    if (input.attempt && (input.attempt.id !== input.attemptId || input.attempt.issueId !== input.issue.id))
      throw new Error(
        "SpawnAgentRunnerAdapter.spawn: attempt identity differs from input. Pass the caller's matching attempt.",
      )

    const attempt: RunAttempt = input.attempt ?? {
      id: input.attemptId,
      issueId: input.issue.id,
      workspacePath: input.workspace.path,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }
    const handle = new ServiceBackedRunHandle(input, attempt, this.service, this.lifecycle?.(input))
    handle.start()
    return handle
  }
}

class RunHandleEmitter {
  private readonly handlers = new Set<(event: AgentRunEvent) => void>()
  private readonly lifecycle: AgentRunEvent[] = []

  subscribe(handler: (event: AgentRunEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    // A run may finish during start(). Its lifecycle remains observable after spawn().
    for (const event of this.lifecycle) this.deliver(handler, event)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(event: AgentRunEvent): void {
    if (event.kind !== "output") this.lifecycle.push(event)
    for (const handler of [...this.handlers]) this.deliver(handler, event)
  }

  private deliver(handler: (event: AgentRunEvent) => void, event: AgentRunEvent): void {
    try {
      handler(event)
    } catch {
      // Subscribers cannot disrupt execution or other observers.
    }
  }
}

class ServiceBackedRunHandle implements RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  readonly result: Promise<RunAttempt>
  readonly executionCapabilities: ExecutionCapabilities = {
    cancellation: "confirmed",
    forceStop: true,
    reconnect: false,
  }
  private readonly emitter = new RunHandleEmitter()
  private alive = true
  private starting: Promise<void> = Promise.resolve()
  private ending?: Promise<void>
  private cancelled = false
  private began = false
  private resolveResult!: (attempt: RunAttempt) => void
  private rejectResult!: (error: AgentRunError) => void
  private abort?: () => void

  constructor(
    private readonly input: SpawnInput,
    private readonly attempt: RunAttempt,
    private readonly service: AgentRunnerService,
    private readonly lifecycle?: LocalRunLifecycle,
  ) {
    this.attemptId = input.attemptId
    this.issueKey = input.issue.identifier
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve
      this.rejectResult = reject
    })
    // Event-only callers need not await result. The original promise still rejects for awaiters.
    void this.result.catch(() => {})
  }

  start(): void {
    this.starting = Promise.resolve().then(async () => {
      if (this.cancelled || this.input.signal?.aborted) return
      await this.lifecycle?.begin()
      this.began = true
      if (this.cancelled || this.input.signal?.aborted) return
      this.emitter.emit({ kind: "started", attemptId: this.attemptId })
      await this.service.spawn(
        this.attempt,
        {
          agentType: this.input.agentType,
          model: this.input.model,
          timeout: Math.max(1, Math.round((this.input.timeoutMs ?? 3_600_000) / 1000)),
          prompt: this.input.prompt,
          workspacePath: this.input.workspace.path,
          env: this.input.env,
        },
        {
          onComplete: (completed) => {
            void this.finish(completed)
          },
          onError: (error) => {
            const observed = {
              ...this.attempt,
              finishedAt: new Date().toISOString(),
              exitCode: error.exitCode ?? null,
              tokenUsage: error.tokenUsage,
            }
            void this.finish(observed, new AgentRunError(error.message, observed, error))
          },
          onHeartbeat: () => {},
          onSpawned: (pid) => this.lifecycle?.spawned(pid),
          onOutput: (text) => this.emitter.emit({ kind: "output", attemptId: this.attemptId, text }),
        },
      )
    })
    void this.starting.catch((error) => {
      void this.finish(this.attempt, this.runError(error))
    })
    this.abort = () => {
      void this.cancel().catch(() => {})
    }
    this.input.signal?.addEventListener("abort", this.abort, { once: true })
    if (this.input.signal?.aborted) this.abort()
  }

  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe {
    return this.emitter.subscribe(handler)
  }

  async send(cmd: InterventionCommand): Promise<void> {
    const caps = defaultCapabilities(this.input.agentType)
    if (!caps.includes(cmd.kind as InterventionCapability))
      throw new InterventionUnsupportedError(cmd.kind, this.input.agentType)
    if (cmd.kind === "abort") return this.cancel()

    await this.starting
    const session = this.service.getSession(this.attemptId)
    if (!this.alive || !session?.isAlive())
      throw new Error(`Attempt "${this.attemptId}" has no live session. Check RunHandle.isAlive() before intervention.`)
    if (cmd.kind === "pause" || cmd.kind === "resume") {
      const action = session[cmd.kind]
      if (!action) throw new InterventionUnsupportedError(cmd.kind, this.input.agentType)
      await action.call(session)
      return
    }
    if (session.sendUserMessage) return session.sendUserMessage(cmd.text)
    throw new Error(
      `Agent "${this.input.agentType}" is stateless at the port level. Route append_prompt through InterventionBus for cancel and retry.`,
    )
  }

  async cancel(): Promise<void> {
    this.cancelled = true
    if (this.ending) return this.ending
    const observed = { ...this.attempt, finishedAt: new Date().toISOString() }
    return this.finish(
      observed,
      new AgentRunError("Order interrupted. Execution was cancelled; resume the mission to continue.", observed, {
        code: "CANCELLED",
      }),
    )
  }

  kill(): Promise<void> {
    return this.cancel()
  }

  isAlive(): boolean {
    return this.alive
  }

  private finish(observed: RunAttempt, failure?: AgentRunError): Promise<void> {
    if (this.ending) return this.ending
    this.alive = false
    this.ending = Promise.resolve().then(async () => {
      let error = failure
      try {
        // Cancel before joining start: a delayed start must not run the prompt after cancellation.
        await this.service.kill(this.attemptId)
        await this.starting.catch(() => {})
        await this.service.waitForAttempt(this.attemptId)
        if (this.began) await this.lifecycle?.finish()
      } catch (cleanupError) {
        error = this.runError(cleanupError, observed, true)
      }
      if (this.abort) this.input.signal?.removeEventListener("abort", this.abort)
      if (error) {
        this.rejectResult(error)
        this.emitter.emit({ kind: "error", attemptId: this.attemptId, error })
        if (error.outcomeUnknown) throw error
      } else {
        this.resolveResult(observed)
        this.emitter.emit({ kind: "complete", attemptId: this.attemptId, exitCode: observed.exitCode })
      }
    })
    // Terminal callbacks are fire-and-forget; result carries cleanup failures to the caller.
    void this.ending.catch(() => {})
    return this.ending
  }

  private runError(error: unknown, observed = this.attempt, outcomeUnknown = false): AgentRunError {
    if (error instanceof AgentRunError && !outcomeUnknown) return error
    return new AgentRunError(error instanceof Error ? error.message : String(error), observed, { outcomeUnknown })
  }
}

export type InternalRunHandleEmitter = RunHandleEmitter
