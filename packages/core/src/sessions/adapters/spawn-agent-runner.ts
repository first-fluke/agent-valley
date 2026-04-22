/**
 * SpawnAgentRunnerAdapter — Infrastructure adapter that implements the
 * domain `AgentRunnerPort` on top of the existing process-spawning
 * `AgentRunnerService`.
 *
 * Composition: the adapter owns an `AgentRunnerService` and exposes it
 * via `.service` so the in-transition Application code
 * (`OrchestratorCore`) can keep using the callback-based classical API
 * while external call-sites (dashboard intervention bus) consume the
 * port's `RunHandle` stream shape.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.4 (PR4).
 *
 * Intervention support table:
 *   claude  — ["append_prompt", "abort"]               (stateless; pause/resume absent)
 *   codex   — ["pause", "resume", "append_prompt", "abort"]
 *   gemini  — ["append_prompt", "abort"] conservatively (ACP-mode caps known only at runtime)
 *
 * The Claude append_prompt implementation (cancel + respawn with merged
 * prompt) is stubbed in this PR — send() throws for now so the failure
 * path is still well-defined. See TODO below.
 */

import type { RunAttempt } from "../../domain/models"
import type {
  AgentRunEvent,
  AgentRunnerPort,
  InterventionCapability,
  InterventionCommand,
  RunHandle,
  SpawnInput,
  Unsubscribe,
} from "../../domain/ports/agent-runner"
import { InterventionUnsupportedError } from "../../domain/ports/agent-runner"
import { AgentRunnerService, type RunCallbacks, type RunOptions } from "../../orchestrator/agent-runner"
import type { AgentSession } from "../agent-session"

/** Static capability table. Keeps `capabilities()` O(1) and UI-queryable. */
export const CAPABILITY_TABLE: Record<string, InterventionCapability[]> = Object.freeze({
  claude: ["append_prompt", "abort"],
  codex: ["pause", "resume", "append_prompt", "abort"],
  gemini: ["append_prompt", "abort"],
}) as Record<string, InterventionCapability[]>

/** Maps agent type name to an expected default capability set (read-only). */
export function defaultCapabilities(agentType: string): InterventionCapability[] {
  return CAPABILITY_TABLE[agentType] ?? ["append_prompt", "abort"]
}

export class SpawnAgentRunnerAdapter implements AgentRunnerPort {
  /** Exposed so OrchestratorCore keeps the classical callback-based API in PR4. */
  public readonly service: AgentRunnerService

  constructor(service?: AgentRunnerService) {
    this.service = service ?? new AgentRunnerService()
  }

  capabilities(agentType: string): InterventionCapability[] {
    return defaultCapabilities(agentType)
  }

  async spawn(input: SpawnInput): Promise<RunHandle> {
    if (!input.attemptId) {
      throw new Error(
        "SpawnAgentRunnerAdapter.spawn: input.attemptId is required.\n" +
          "  Fix: mint a stable attemptId upstream and pass it on SpawnInput.\n" +
          "  Location: caller of AgentRunnerPort.spawn.",
      )
    }
    if (!input.agentType) {
      throw new Error(
        "SpawnAgentRunnerAdapter.spawn: input.agentType is required.\n" +
          "  Fix: pass the resolved agent type (e.g. 'claude' | 'codex' | 'gemini').\n" +
          "  Location: caller of AgentRunnerPort.spawn.",
      )
    }

    const attempt: RunAttempt = {
      id: input.attemptId,
      issueId: input.issue.id,
      workspacePath: input.workspace.path,
      retryCount: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    }

    const emitter = new RunHandleEmitter()

    const options: RunOptions = {
      agentType: input.agentType,
      timeout: Math.max(1, Math.round((input.timeoutMs ?? 3_600_000) / 1000)),
      prompt: input.prompt,
      workspacePath: input.workspace.path,
    }

    const callbacks: RunCallbacks = {
      onComplete: (result) => {
        emitter.emit({ kind: "complete", attemptId: input.attemptId, exitCode: result.exitCode })
      },
      onError: (error) => {
        emitter.emit({
          kind: "error",
          attemptId: input.attemptId,
          error: new Error(`${error.code}: ${error.message}`),
        })
      },
      onHeartbeat: () => {
        /* intentionally not surfaced on the port event stream */
      },
    }

    // Wire an output-side tap before spawn so early chunks are delivered.
    const service = this.service
    await service.ensureRegistered()
    // Access the session post-spawn to attach a listener; AgentRunnerService
    // does not expose its Map, so we hook via the registry-bound factory.
    // Simpler: the port's "output" event is best-effort in this PR — the
    // existing AgentRunnerService already records last-output snippets for
    // the status surface. Future work: push raw chunks through the port.
    await service.spawn(attempt, options, callbacks)
    emitter.emit({ kind: "started", attemptId: input.attemptId })

    return new ServiceBackedRunHandle({
      attemptId: input.attemptId,
      issueKey: input.issue.identifier,
      agentType: input.agentType,
      service,
      emitter,
    })
  }
}

// ── Handle + emitter internals ────────────────────────────────────────

class RunHandleEmitter {
  private readonly handlers = new Set<(event: AgentRunEvent) => void>()

  subscribe(handler: (event: AgentRunEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(event: AgentRunEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(event)
      } catch {
        /* handler errors are isolated */
      }
    }
  }
}

interface ServiceHandleDeps {
  attemptId: string
  issueKey: string
  agentType: string
  service: AgentRunnerService
  emitter: RunHandleEmitter
}

class ServiceBackedRunHandle implements RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  private readonly agentType: string
  private readonly service: AgentRunnerService
  private readonly emitter: RunHandleEmitter
  private alive = true

  constructor(deps: ServiceHandleDeps) {
    this.attemptId = deps.attemptId
    this.issueKey = deps.issueKey
    this.agentType = deps.agentType
    this.service = deps.service
    this.emitter = deps.emitter
  }

  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe {
    return this.emitter.subscribe(handler)
  }

  async send(cmd: InterventionCommand): Promise<void> {
    const caps = defaultCapabilities(this.agentType)
    if (!caps.includes(cmd.kind as InterventionCapability)) {
      throw new InterventionUnsupportedError(cmd.kind, this.agentType)
    }

    // Supported branches.
    if (cmd.kind === "abort") {
      await this.cancel()
      return
    }

    if (cmd.kind === "append_prompt") {
      // TODO(PR4-C): implement per-agent append_prompt delivery.
      //   - claude (stateless): cancel current session + respawn with merged prompt
      //   - codex: JSON-RPC user_message
      //   - gemini (ACP): message queue
      // For now the capability is advertised but delivery is stubbed so
      // callers get a clear, actionable failure rather than silent drop.
      throw new Error(
        `SpawnAgentRunnerAdapter.send(append_prompt): not yet implemented for agent "${this.agentType}".\n` +
          `  Fix: wait for PR4-C wiring, or use send({ kind: "abort", ... }) instead.\n` +
          `  Tracking: docs/plans/v0-2-bigbang-design.md § 4.4.`,
      )
    }

    if (cmd.kind === "pause" || cmd.kind === "resume") {
      // TODO(PR4-C): wire pause/resume into CodexSession JSON-RPC (interrupt / resume).
      throw new Error(
        `SpawnAgentRunnerAdapter.send(${cmd.kind}): not yet implemented for agent "${this.agentType}".\n` +
          `  Fix: wait for PR4-C wiring of Codex interrupt/resume.\n` +
          `  Tracking: docs/plans/v0-2-bigbang-design.md § 4.4.`,
      )
    }
  }

  async cancel(): Promise<void> {
    await this.service.kill(this.attemptId)
    this.alive = false
  }

  async kill(): Promise<void> {
    await this.service.kill(this.attemptId)
    this.alive = false
  }

  isAlive(): boolean {
    // The underlying service removes the session from its map as soon as
    // kill() is requested; liveness is best-effort. `alive` stays true
    // between spawn and the first cancel/kill/complete event.
    return this.alive
  }
}

// Re-exported so unit tests can wait for emitter-driven lifecycle without
// depending on private classes.
export type InternalRunHandleEmitter = RunHandleEmitter

/** Expose AgentSession lookup shape used by tests to stub session behavior. */
export type { AgentSession }
