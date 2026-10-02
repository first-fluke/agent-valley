import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { coordinate } from "@agent-valley/core/chief/coordinator"
import { ChiefRuntime, missionIssue } from "@agent-valley/core/chief/runtime"
import { MissionStore } from "@agent-valley/core/chief/store"
import type { Mission } from "@agent-valley/core/chief/types"
import { WorkspaceManager } from "@agent-valley/core/workspace/workspace-manager"
import type { Command } from "commander"
import { type OrderOptions, resolveOrderConfig } from "./chief-config"

export async function runOrder(
  goal: string | undefined,
  options: OrderOptions,
  root = process.cwd(),
): Promise<Mission> {
  const store = new MissionStore(join(root, ".agent-valley/missions"))
  const id = options.resume ?? randomUUID()
  const unlock = await store.lock(id)
  const abortController = new AbortController()
  const interrupt = () => abortController.abort()
  const runtime = new ChiefRuntime(store, abortController.signal, (stage, persona) =>
    console.log(`[${stage}] ${persona.name}`),
  )
  process.once("SIGINT", interrupt)
  process.once("SIGTERM", interrupt)
  try {
    store.processGuard(id).assertIdle()
    let mission: Mission
    if (options.resume) {
      if (goal || Object.keys(options).some((key) => key !== "resume"))
        throw new Error("Resume uses the saved goal, personas and acceptance command. Pass only --resume <id>.")
      mission = await store.load(id)
    } else {
      if (!goal?.trim())
        throw new Error(
          "Give the chief a goal: av order \"Investigate and fix the login failure\" --workspace /repo --verify 'npm test'.",
        )
      if (goal.length > 32_000)
        throw new Error(
          "Order goal exceeds 32 KB. Put supporting details in repository files and reference them in a shorter goal.",
        )
      const config = resolveOrderConfig(root, options)
      const workspace = await new WorkspaceManager(config.workspace).create(missionIssue(id, goal))
      const now = new Date().toISOString()
      mission = {
        id,
        goal,
        workspace,
        chiefId: config.chiefId,
        personas: config.personas,
        verifyCommand: config.verifyCommand,
        timeoutSec: config.timeoutSec,
        maxRepairs: config.maxRepairs,
        oma: config.oma,
        status: "pending",
        tasks: [],
        history: [],
        createdAt: now,
        updatedAt: now,
      }
      await store.save(mission)
    }
    console.log(`Order ${id}\nWorkspace: ${mission.workspace.path}\nResume: bun av order --resume ${id}`)
    const result = await coordinate(mission, runtime.ports())
    console.log(
      `Order ${result.status}: ${result.finalReview?.summary ?? result.goal}\nWorktree: ${result.workspace.path}\nBranch: ${result.workspace.branch}`,
    )
    return result
  } finally {
    process.removeListener("SIGINT", interrupt)
    process.removeListener("SIGTERM", interrupt)
    try {
      await runtime.close()
    } finally {
      await unlock()
    }
  }
}

export function registerChiefCommands(program: Command): void {
  program
    .command("order [goal]")
    .description("Give a chief a goal; delegate, review, repair and verify in an isolated worktree")
    .option("--workspace <path>", "Target Git repository (defaults to valley.yaml)")
    .option("--verify <command>", "Trusted completion check (defaults to valley.yaml)")
    .option("--agent <type>", "Default agent CLI for the persona roster")
    .option("--chief <id>", "Chief persona ID")
    .option("--personas <file>", "YAML file with chief and personas entries")
    .option("--oma", "Use installed OMA skills and require OMA completion receipts for workers")
    .option("--timeout <seconds>", "Timeout per agent/check (default 600 or agent.timeout)")
    .option("--repairs <count>", "Repair limit per task/final review (default 2)")
    .option("--resume <id>", "Resume a saved order with its original acceptance contract")
    .action(async (goal: string | undefined, options: OrderOptions) => {
      await runOrder(goal, options)
    })

  program
    .command("missions")
    .description("List saved chief orders and their workspaces")
    .action(async () => {
      const missions = await new MissionStore(join(process.cwd(), ".agent-valley/missions")).list()
      if (!missions.length) console.log("No orders yet. Run bun av order --help.")
      for (const mission of missions) {
        console.log(
          `${mission.id}  ${mission.status}  ${mission.tasks.filter((task) => task.status === "completed").length}/${mission.tasks.length}  ${mission.goal.slice(0, 100)}`,
        )
        console.log(`  ${mission.workspace.path}${mission.error ? `\n  ${mission.error}` : ""}`)
      }
    })
}
