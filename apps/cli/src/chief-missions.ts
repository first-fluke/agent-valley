import { join } from "node:path"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Command } from "commander"
import { registerMissionReconciliation } from "./chief-reconcile"
import { watchOrders } from "./chief-watch"

export function registerMissionCommands(program: Command): void {
  const missions = program
    .command("missions")
    .description("List saved Chief Director orders and their workspaces")
    .option("--json", "Print a JSON snapshot of saved order status")
    .option("--watch", "Resume due or interrupted orders from their saved checkpoints")
    .option("--service", "Treat watcher SIGTERM as recoverable service shutdown; requires --watch")
    .action(async (options: { json?: boolean; watch?: boolean; service?: boolean }) => {
      if (options.json && options.watch)
        throw new Error(
          "Use av missions --json for a snapshot, or av missions --watch to resume eligible orders; choose one.",
        )
      if (options.service && !options.watch) throw new Error("Use --service with av missions --watch.")
      if (options.watch) {
        await watchOrders(process.cwd(), { service: options.service })
        return
      }
      const missions = await new MissionStore(join(process.cwd(), ".agent-valley/missions")).list()
      if (options.json) {
        console.log(
          JSON.stringify(
            missions.map((mission) => ({
              id: mission.id,
              status: mission.status,
              goal: mission.goal,
              workspacePath: mission.workspace.path,
              branch: mission.workspace.branch,
              completedTasks: mission.tasks.filter((task) => task.status === "completed").length,
              totalTasks: mission.tasks.length,
              reason: mission.codeDelivery?.error ?? mission.execution?.pauseReason ?? mission.error ?? null,
              nextRunAt: mission.codeDelivery?.nextRunAt ?? mission.execution?.nextRunAt ?? null,
              delivery: mission.codeDelivery
                ? { phase: mission.codeDelivery.phase, commitSha: mission.codeDelivery.commitSha ?? null }
                : null,
            })),
          ),
        )
        return
      }
      if (!missions.length) console.log("No orders yet. Run bun av order --help.")
      for (const mission of missions) {
        console.log(
          `${mission.id}  ${mission.status}  ${mission.tasks.filter((task) => task.status === "completed").length}/${mission.tasks.length}  ${mission.goal.slice(0, 100)}`,
        )
        console.log(`  ${mission.workspace.path}${mission.error ? `\n  ${mission.error}` : ""}`)
      }
    })
  registerMissionReconciliation(missions)
}
