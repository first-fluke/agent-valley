import { type Command, Option } from "commander"
import { type ContinuousOptions, operationStore, runOperation } from "./chief-continuous"
import { renderOperationReport } from "./chief-continuous-report"
import { pruneOperationArtifacts } from "./operations-prune"

export function registerContinuousCommands(program: Command): void {
  program
    .command("operate [charter]", { hidden: true })
    .description("Deprecated alias for av order; resume existing operating charters")
    .option("--workspace <path>", "Target Git repository (defaults to av.yaml)")
    .addOption(
      new Option(
        "--source-integration <mode>",
        "Apply verified cycles to source files, or preserve snapshots only",
      ).choices(["worktree", "snapshot-only"]),
    )
    .option("--verify <command>", "Trusted completion check for each improvement")
    .option("--actor <type>", "Pinned Chief Director CLI")
    .option("--model <id>", "Pinned Chief Director model")
    .option("--director <id>", "Chief Director Actor ID")
    .option("--actors <file>", "Configured YAML Actor roster")
    .option("--oma", "Require OMA completion receipts for workers")
    .option("--service", "Resume after OS service SIGTERM within saved limits; SIGINT still cancels")
    .option("--timeout <seconds>", "Timeout per Actor/check")
    .option("--repairs <count>", "Repair limit per task/final review")
    .option("--rounds <count>", "Recovery decision limit per improvement")
    .option("--parallel <count>", "Actor concurrency per improvement")
    .option("--runs <count>", "Initial Actor call limit; on resume, increase the active decision checkpoint limit")
    .option("--duration <seconds>", "Initial wall-time limit; on resume, increase the active decision checkpoint limit")
    .option("--cost <usd>", "Initial estimated cost limit; on resume, increase the active decision checkpoint limit")
    .option("--account-run <run-id>", "On resume, reconcile an active decision run whose usage/cost was lost")
    .option("--account-cost <usd>", "Observed USD cost for the decision --account-run after inspecting billing")
    .option("--cycles <count>", "Cumulative verified improvement limit; default continues until stopped")
    .option("--interval <seconds>", "Wait before selecting again when no new goal is justified (default 300)")
    .option("--charter-append <text>", "On operation resume, record an operator correction to the saved charter")
    .option("--charter-supersede <ids>", "With --charter-append, retract earlier amendment IDs (comma-separated)")
    .option("--resume <id>", "Resume the saved charter and accepted work")
    .addOption(new Option("--operation-id <id>", "Internal operation identity").hideHelp())
    .action(async (charter: string | undefined, options: ContinuousOptions) => {
      const operation = await runOperation(charter, options)
      console.log(`Operation ${operation.id}: ${operation.phase}; ${operation.completedCycles} verified improvements.`)
      if (operation.error) console.error(operation.error)
      process.exitCode = operation.phase === "paused" ? 2 : 0
    })
  program
    .command("operations")
    .description("List saved operating charters or read an operation report")
    .option("--report <id>", "Print the saved operation report")
    .option("--prune <id>", "Preview removal of recoverable obsolete baseline clones")
    .option("--apply", "With --prune, remove only confirmed eligible baseline clones")
    .action(async (options: { report?: string; prune?: string; apply?: boolean }) => {
      if (options.prune) {
        if (options.report) throw new Error("Use either --report or --prune for an operation.")
        await pruneOperationArtifacts(options.prune, { apply: options.apply })
        return
      }
      if (options.apply) throw new Error("Use --apply only with --prune <operation-id>.")
      const storage = operationStore(process.cwd())
      if (options.report) {
        console.log(renderOperationReport(await storage.load(options.report)))
        return
      }
      const operations = await storage.list()
      if (!operations.length) console.log("No operations yet. Run av order --help.")
      for (const operation of operations) {
        console.log(
          `${operation.id}  ${operation.phase}  ${operation.completedCycles} completed  ${operation.charter.slice(0, 100)}`,
        )
        if (operation.currentMissionId) console.log(`  Child: ${operation.currentMissionId}`)
        if (operation.error) console.log(`  ${operation.error}`)
      }
    })
}
