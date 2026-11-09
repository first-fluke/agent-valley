import { type Command, Option } from "commander"
import { dispatchOrder } from "./chief"
import { type ContinuousOptions } from "./chief-continuous"
import { registerContinuousCommands } from "./chief-continuous-commands"
import { registerMissionCommands } from "./chief-missions"
import { orderExitCode, printOrderOutcome } from "./chief-outcome"

export function registerChiefCommands(program: Command): void {
  registerContinuousCommands(program)
  program
    .command("order [goal]")
    .description("Give the Chief Director a goal; continuously select, execute, review and verify improvements")
    .option("--once", "Stop after one verified goal instead of continuing improvements")
    .option("--cycles <count>", "Cumulative verified improvement limit; default continues until stopped")
    .option("--interval <seconds>", "Wait before selecting again when no new goal is justified (default 300)")
    .option("--charter-append <text>", "On operation resume, record an operator correction to the saved charter")
    .option("--charter-supersede <ids>", "With --charter-append, retract earlier amendment IDs (comma-separated)")
    .option("--workspace <path>", "Target Git repository (defaults to av.yaml)")
    .addOption(
      new Option(
        "--source-integration <mode>",
        "Apply each verified cycle to source files (new orders: worktree; saved orders retain policy)",
      ).choices(["worktree", "snapshot-only"]),
    )
    .option("--verify <command>", "Trusted completion check (defaults to av.yaml)")
    .option("--deliver <branch>", "Commit and push only verified, reviewed work to the selected source branch")
    .option("--delivery-paths <json>", "JSON array of exact product files allowed for code delivery")
    .option(
      "--delivery-message <text>",
      "Commit message for the approved delivery, including required repository trailers",
    )
    .option("--delivery-remote <name>", "Configured Git remote for code delivery (default origin)")
    .option("--delivery-skip-pre-push", "Authorize git push --no-verify for this delivery; commit hooks remain enabled")
    .option("--actor <type>", "Chief Director CLI (default: saved actor.type, otherwise an authenticated CLI)")
    .option("--model <id>", "Chief Director model (default: actor.model from config, otherwise the CLI default)")
    .option("--director <id>", "Chief Director Actor ID")
    .option("--actors <file>", "Use a configured YAML Actor roster instead of generating goal-specific Actors")
    .addOption(new Option("--agent <type>", "Legacy alias for --actor").hideHelp())
    .addOption(new Option("--chief <id>", "Legacy alias for --director").hideHelp())
    .addOption(new Option("--personas <file>", "Legacy alias for --actors").hideHelp())
    .option("--oma", "Require OMA completion receipts for workers (installed skill selection is automatic)")
    .option(
      "--timeout <seconds>",
      "Timeout per actor/check (default 3600 or actor.timeout); may be increased on resume",
    )
    .option("--repairs <count>", "Repair limit per task/final review (default 2)")
    .option("--rounds <count>", "Recovery decision limit, preserved on resume (default 8, maximum 50)")
    .option("--parallel <count>", "Independent Actor concurrency (default 3, maximum 8)")
    .option(
      "--runs <count>",
      "Actor call limit per goal/decision; may be increased on saved checkpoint resume (default 200)",
    )
    .option("--duration <seconds>", "Wall-time limit per goal/decision; may be increased on resume (default 86400)")
    .option("--cost <usd>", "Configured-price estimated cost limit; unknown cost pauses further calls")
    .option("--account-run <run-id>", "Reconcile a finished run whose usage/cost was lost")
    .option("--account-cost <usd>", "Operator-observed USD cost for --account-run; stored separately from native usage")
    .option("--retry", "Resume after repairing a blocker; retain prior evidence and spent budget")
    .option(
      "--note <text>",
      "Record an operator note on resume (environment or prerequisite change) that Actors and the Chief read before repeating earlier conclusions",
    )
    .option("--resolve-effect <task-id>", "Reconcile an interrupted external action before resuming")
    .option("--effect-result <result>", "External destination inspection result: completed or not-applied")
    .option("--no-supervise", "With --once, run directly without worker crash restart or observation polling")
    .option("--service", "Resume after OS service SIGTERM within saved limits; SIGINT still cancels")
    .addOption(new Option("--worker", "Internal supervised worker").hideHelp())
    .addOption(new Option("--mission-id <id>", "Internal mission identity").hideHelp())
    .addOption(new Option("--baseline-workspace <path>", "Internal accepted operation snapshot").hideHelp())
    .addOption(new Option("--operation-id <id>", "Internal operation identity").hideHelp())
    .addOption(new Option("--native-model", "Internal pinned Chief native model default").hideHelp())
    .option("--resume <id>", "Resume the saved continuing order or single mission with its original contract")
    .action(async (goal: string | undefined, options: ContinuousOptions) => {
      const result = await dispatchOrder(goal, options)
      if ("phase" in result) {
        console.log(`Order ${result.id}: ${result.phase}; ${result.completedCycles} verified improvements.`)
        if (result.error) console.error(result.error)
        process.exitCode = result.phase === "paused" ? 2 : 0
      } else {
        if (!options.worker) printOrderOutcome(result)
        process.exitCode = orderExitCode(result)
      }
    })

  registerMissionCommands(program)
}
