import type { AgentRunnerPort } from "../domain/ports/agent-runner"
import { SpawnAgentRunnerAdapter } from "../sessions/adapters/spawn-agent-runner"
import type { ActiveMissionProcess } from "./active-process"
import { MissionPause } from "./execution"
import type { MissionStore } from "./store"

/** Local process cleanup can lag while the OS reaps the final process group. */
export async function finishLocalProcess(active: ActiveMissionProcess): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      active.finish()
      return
    } catch (error) {
      if (attempt >= 20)
        throw new MissionPause(
          `Actor process cleanup could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
          "unknown-effect",
        )
      await new Promise((resolveWait) => setTimeout(resolveWait, 50))
    }
  }
}

export function createLocalMissionRunner(store: MissionStore): AgentRunnerPort {
  return new SpawnAgentRunnerAdapter(undefined, (input) => {
    const active = store.processGuard(input.issue.id, input.attemptId)
    return {
      begin: () => active.begin(input.stage ?? "agent"),
      spawned: (pid) => active.spawned(pid, process.platform !== "win32"),
      finish: () => finishLocalProcess(active),
    }
  })
}
