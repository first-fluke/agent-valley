/**
 * Orchestrator — Core Symphony component.
 * Webhook-driven event handler, state machine, retry queue.
 * Sole authority over in-memory runtime state.
 *
 * This file is the public facade. Internals are split into three
 * collaborators (PR3 — docs/plans/v0-2-bigbang-design.md § 3.1, § 5.3):
 *   - OrchestratorCore     (owns OrchestratorRuntimeState + sub-services)
 *   - IssueLifecycle       (state transitions, workspace/agent dispatch)
 *   - WebhookRouter        (signature check + event routing)
 *
 * The public constructor signature and public methods
 * (start / stop / getHandlers / on / off) are unchanged so external
 * callers (apps/dashboard bootstrap, relay/ledger-bridge) remain
 * bit-compatible with v0.1.
 */

import type { Config } from "../config/yaml-loader"
import type { ParsedWebhookEvent } from "../domain/parsed-webhook-event"
import type { IssueTracker, WebhookReceiver } from "../domain/ports/tracker"
import type { WorkspaceGateway } from "../domain/ports/workspace"
import type { ObservabilityHooks } from "../observability/hooks"
import { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import { OrchestratorEventEmitter } from "./event-emitter"
import { IssueLifecycle } from "./issue-lifecycle"
import { OrchestratorCore } from "./orchestrator-core"
import { WebhookRouter } from "./webhook-router"

export class Orchestrator extends OrchestratorEventEmitter {
  private readonly core: OrchestratorCore
  private readonly lifecycle: IssueLifecycle
  private readonly router: WebhookRouter

  constructor(
    config: Config,
    tracker: IssueTracker,
    webhook: WebhookReceiver<ParsedWebhookEvent>,
    workspace: WorkspaceGateway,
    agentRunner?: SpawnAgentRunnerAdapter,
    observability?: ObservabilityHooks,
  ) {
    super()

    // Default: construct the adapter here so v0.1 callers with no
    // explicit injection keep bit-identical behavior. External callers
    // (bootstrap, integration tests) may pass a pre-built adapter so
    // they can observe capability queries and RunHandle events through
    // the same instance the orchestrator uses internally.
    const runner: SpawnAgentRunnerAdapter = agentRunner ?? new SpawnAgentRunnerAdapter()

    this.core = new OrchestratorCore({
      config,
      tracker,
      webhook,
      workspace,
      agentRunner: runner,
      emit: (event, payload) => this.emitEvent(event, payload),
      observability,
    })

    this.lifecycle = new IssueLifecycle(this.core)
    this.router = new WebhookRouter(this.core, this.lifecycle)

    // Wire the core back-channel so startup sync / retry queue / fill
    // vacant slots can drive lifecycle transitions. Doing this after
    // lifecycle construction keeps the ownership graph acyclic.
    this.core.attachLifecycle(
      {
        handleIssueTodo: (issue, retryContext) => this.lifecycle.handleIssueTodo(issue, retryContext),
        handleIssueInProgress: (issue, retryContext) => this.lifecycle.handleIssueInProgress(issue, retryContext),
      },
      () => this.lifecycle.reevaluateWaitingIssues(),
    )
  }

  async start(): Promise<void> {
    await this.core.start()
  }

  async stop(): Promise<void> {
    await this.core.stop()
  }

  /**
   * Returns handler callbacks for the Presentation layer to wire into the HTTP server.
   * This keeps the Application layer free of Presentation imports.
   */
  getHandlers(): {
    onWebhook: (payload: string, signature: string) => Promise<{ status: number; body: string }>
    getStatus: () => Record<string, unknown>
  } {
    return {
      onWebhook: (payload, signature) => this.router.handleWebhook(payload, signature),
      getStatus: () => this.core.getStatus(),
    }
  }
}
