import { type Command, Option } from "commander"
import type { SetupOptions } from "./noninteractive-types"

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Interactive setup wizard or unattended local order setup")
    .option("--edit", "Modify specific values in existing config")
    .addOption(
      new Option("--mode <mode>", "Local orders (default) or issue tracker automation")
        .choices(["order", "tracker"])
        .conflicts("edit"),
    )
    .option("-y, --yes", "Configure local orders without prompts or interactive login")
    .option("--actor <type>", "Chief Director vendor (current runtime, then saved settings if omitted)")
    .option("--model <id>", "Current Chief Director model; pass an empty string to clear a saved pin")
    .option("--workspace <path>", "Target Git repository; AV config remains in the invocation directory")
    .option("--verify <command>", "Trusted acceptance command; otherwise saved or Chief-designed checks")
    .option("--oma <action>", "Prepare latest OMA (default) or explicitly skip preparation")
    .option("--json", "Emit a single machine-readable setup result (requires --yes)")
    .action(async (options: SetupOptions) => {
      if (options.yes) {
        const { setupNoninteractive, printNoninteractiveSetupResult } = await import("./noninteractive")
        const result = await setupNoninteractive(options)
        printNoninteractiveSetupResult(result, options.json)
        process.exitCode = result.exitCode
        return
      }
      if (
        [options.actor, options.model, options.workspace, options.verify, options.oma, options.json].some(
          (value) => value !== undefined,
        )
      )
        throw new Error(
          "Use --yes with --actor, --model, --workspace, --verify, --oma or --json for unattended local setup; omit these flags for the interactive wizard.",
        )
      const { setup, setupEdit } = await import("./index")
      if (options.edit) await setupEdit()
      else await setup({ mode: options.mode as "order" | "tracker" | undefined })
    })
}
