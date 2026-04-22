/**
 * FakeAgentRunner — in-memory `AgentRunnerPort` implementation.
 *
 * Design: docs/plans/v0-2-bigbang-design.md § 4.4 (PR4).
 *
 * Semantics mirror the production adapter:
 *   - `spawn()` emits a `started` event synchronously, returns a handle.
 *   - `send()` enforces the same capability table, throws
 *     `InterventionUnsupportedError` for unsupported commands.
 *   - `cancel()` / `kill()` flip liveness and emit a `complete` event
 *     with exit code -1 so tests can await termination.
 *   - Tests can `emitRaw()` to inject additional events (output/error).
 */

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

const DEFAULT_CAPS: Record<string, InterventionCapability[]> = {
  claude: ["append_prompt", "abort"],
  codex: ["pause", "resume", "append_prompt", "abort"],
  gemini: ["append_prompt", "abort"],
}

export interface FakeAgentRunnerOptions {
  /** Override the default per-agent capability map. */
  capabilities?: Record<string, InterventionCapability[]>
  /** Hook called when `spawn()` is invoked. Throw to simulate spawn failure. */
  onSpawn?: (input: SpawnInput) => void | Promise<void>
}

export class FakeAgentRunner implements AgentRunnerPort {
  readonly spawnCalls: SpawnInput[] = []
  readonly handles: FakeRunHandle[] = []
  readonly capabilityQueries: string[] = []
  private readonly capMap: Record<string, InterventionCapability[]>
  private readonly onSpawn?: (input: SpawnInput) => void | Promise<void>

  constructor(opts: FakeAgentRunnerOptions = {}) {
    this.capMap = opts.capabilities ?? DEFAULT_CAPS
    this.onSpawn = opts.onSpawn
  }

  capabilities(agentType: string): InterventionCapability[] {
    this.capabilityQueries.push(agentType)
    return this.capMap[agentType] ?? ["append_prompt", "abort"]
  }

  async spawn(input: SpawnInput): Promise<RunHandle> {
    if (!input.attemptId) {
      throw new Error(
        "FakeAgentRunner.spawn: input.attemptId is required.\n" +
          "  Fix: pass a stable attemptId in SpawnInput.\n" +
          "  Location: test setup.",
      )
    }
    if (!input.agentType) {
      throw new Error(
        "FakeAgentRunner.spawn: input.agentType is required.\n" +
          "  Fix: pass the resolved agent type in SpawnInput.\n" +
          "  Location: test setup.",
      )
    }

    this.spawnCalls.push(input)
    if (this.onSpawn) await this.onSpawn(input)

    const handle = new FakeRunHandle({
      attemptId: input.attemptId,
      issueKey: input.issue.identifier,
      agentType: input.agentType,
      caps: this.capabilities(input.agentType),
    })
    this.handles.push(handle)
    handle.emitRaw({ kind: "started", attemptId: input.attemptId })
    return handle
  }
}

export class FakeRunHandle implements RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  readonly agentType: string
  readonly caps: InterventionCapability[]
  readonly sendCalls: InterventionCommand[] = []
  cancelCalls = 0
  killCalls = 0
  private readonly handlers = new Set<(event: AgentRunEvent) => void>()
  private alive = true

  constructor(deps: { attemptId: string; issueKey: string; agentType: string; caps: InterventionCapability[] }) {
    this.attemptId = deps.attemptId
    this.issueKey = deps.issueKey
    this.agentType = deps.agentType
    this.caps = deps.caps
  }

  onEvent(handler: (event: AgentRunEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  async send(cmd: InterventionCommand): Promise<void> {
    this.sendCalls.push(cmd)
    if (!this.caps.includes(cmd.kind as InterventionCapability)) {
      throw new InterventionUnsupportedError(cmd.kind, this.agentType)
    }
    if (cmd.kind === "abort") {
      await this.cancel()
    }
    // Other supported commands are no-ops on the fake — tests that need
    // observable effects should assert on `sendCalls`.
  }

  async cancel(): Promise<void> {
    if (!this.alive) return
    this.cancelCalls++
    this.alive = false
    this.emitRaw({ kind: "complete", attemptId: this.attemptId, exitCode: -1 })
  }

  async kill(): Promise<void> {
    if (!this.alive) return
    this.killCalls++
    this.alive = false
    this.emitRaw({ kind: "complete", attemptId: this.attemptId, exitCode: -1 })
  }

  isAlive(): boolean {
    return this.alive
  }

  /** Test-driver API — inject a raw event. */
  emitRaw(event: AgentRunEvent): void {
    for (const h of [...this.handlers]) {
      try {
        h(event)
      } catch {
        /* isolate handler errors */
      }
    }
  }
}
