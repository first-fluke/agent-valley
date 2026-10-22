import { resolve } from "node:path"
import type { AgentRunnerPort, InterventionCapability, RunHandle, SpawnInput } from "../../domain/ports/agent-runner"
import { A2aClient, type A2aClientDependencies } from "./a2a-client"
import type { A2aEndpoint, A2aLifecycleFactory } from "./a2a-contracts"
import { A2aRunHandle } from "./a2a-run-handle"

/** A2A 1.0 JSON-RPC backend; Mission authority and artifact acceptance stay in AV. */
export class A2aAgentRunnerAdapter implements AgentRunnerPort {
  private readonly client: A2aClient

  constructor(
    endpoint: A2aEndpoint,
    private readonly lifecycle: A2aLifecycleFactory,
    dependencies: A2aClientDependencies = {},
  ) {
    this.client = new A2aClient(endpoint, dependencies)
  }

  capabilities(_agentType: string): InterventionCapability[] {
    return ["abort"]
  }

  async spawn(input: SpawnInput): Promise<RunHandle> {
    if (!input.attemptId || !input.agentType || !input.prompt.trim())
      throw new Error(
        "A2A execution requires attemptId, agentType and a nonempty prompt. Restore the saved input before dispatch.",
      )
    if (
      input.attempt &&
      (input.attempt.id !== input.attemptId ||
        input.attempt.issueId !== input.issue.id ||
        resolve(input.attempt.workspacePath) !== resolve(input.workspace.path))
    )
      throw new Error(
        "A2A attempt identity differs from its input. Restore the matching saved attempt before dispatch.",
      )
    const handle = new A2aRunHandle(input, this.client, this.lifecycle(input))
    handle.start()
    return handle
  }
}
