import { readFile, stat } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import {
  addOrganizationMemory,
  importBusinessMetrics,
  listBusinessExperiments,
  listBusinessMetrics,
  listOrganizationMemories,
  recordBusinessExperiment,
  recordBusinessMetric,
} from "@agent-valley/core/chief/organization"
import { listReportDeliveries, retryPendingReports } from "@agent-valley/core/chief/report-delivery"
import { mergeChiefConfig } from "@agent-valley/core/config/chief-schema"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import type { Command } from "commander"

export function organizationRepository(root: string, workspace?: string): string {
  const repository = workspace ?? loadProjectConfig(root)?.workspace?.root ?? root
  if (!isAbsolute(repository))
    throw new Error("Set workspace.root in av.yaml or --workspace to an absolute source repository path.")
  return repository
}
async function inputFile(file: string): Promise<string> {
  const path = resolve(file)
  const info = await stat(path)
  if (!info.isFile() || info.size > 2_000_000) throw new Error("Use a regular JSON input file no larger than 2 MB.")
  return readFile(path, "utf8")
}
export function registerOrganizationCommands(program: Command): void {
  const memory = program.command("memory").description("Repository organization decisions and standards")
  memory
    .command("list")
    .option("--workspace <path>", "Source repository")
    .action(async (opts: { workspace?: string }) => {
      console.log(
        JSON.stringify(await listOrganizationMemories(organizationRepository(process.cwd(), opts.workspace)), null, 2),
      )
    })
  memory
    .command("add <content>")
    .option("--workspace <path>", "Source repository")
    .option("--kind <kind>", "lesson, decision or stack-standard", "lesson")
    .option("--source <source>", "Decision source")
    .option("--tags <tags>", "Comma-separated retrieval tags")
    .action(async (content: string, opts: { workspace?: string; kind: string; source?: string; tags?: string }) => {
      console.log(
        JSON.stringify(
          await addOrganizationMemory(organizationRepository(process.cwd(), opts.workspace), {
            content,
            kind: opts.kind,
            source: opts.source,
            tags:
              opts.tags
                ?.split(",")
                .map((tag) => tag.trim())
                .filter(Boolean) ?? [],
          }),
          null,
          2,
        ),
      )
    })
  const metrics = program.command("metrics").description("Record sourced business observations and experiments")
  metrics
    .command("record <name> <value>")
    .requiredOption("--unit <unit>", "Measurement unit")
    .requiredOption("--source <source>", "Actual observation source")
    .requiredOption("--at <timestamp>", "ISO observation time")
    .option("--workspace <path>", "Source repository")
    .option("--experiment <id>", "Experiment ID")
    .action(
      async (
        name: string,
        value: string,
        opts: { workspace?: string; unit: string; source: string; at: string; experiment?: string },
      ) => {
        if (!value.trim() || !Number.isFinite(Number(value))) throw new Error("Metric value must be a finite number.")
        console.log(
          JSON.stringify(
            await recordBusinessMetric(organizationRepository(process.cwd(), opts.workspace), {
              name,
              value: Number(value),
              unit: opts.unit,
              source: opts.source,
              timestamp: opts.at,
              experimentId: opts.experiment,
            }),
            null,
            2,
          ),
        )
      },
    )
  metrics
    .command("list")
    .option("--workspace <path>", "Source repository")
    .action(async (opts: { workspace?: string }) => {
      console.log(
        JSON.stringify(await listBusinessMetrics(organizationRepository(process.cwd(), opts.workspace)), null, 2),
      )
    })
  metrics
    .command("import <file>")
    .option("--workspace <path>", "Source repository")
    .action(async (file: string, opts: { workspace?: string }) => {
      console.log(
        JSON.stringify(
          await importBusinessMetrics(organizationRepository(process.cwd(), opts.workspace), await inputFile(file)),
          null,
          2,
        ),
      )
    })
  metrics
    .command("experiment")
    .option("--file <file>", "Record a JSON experiment; otherwise list")
    .option("--workspace <path>", "Source repository")
    .action(async (opts: { workspace?: string; file?: string }) => {
      const repository = organizationRepository(process.cwd(), opts.workspace)
      console.log(
        JSON.stringify(
          opts.file
            ? await recordBusinessExperiment(repository, JSON.parse(await inputFile(opts.file)))
            : await listBusinessExperiments(repository),
          null,
          2,
        ),
      )
    })
  const reports = program.command("reports").description("Inspect and retry third-party report attachments")
  reports
    .command("list")
    .option("--workspace <path>", "Source repository")
    .action(async (opts: { workspace?: string }) => {
      console.log(
        JSON.stringify(
          await listReportDeliveries(join(organizationRepository(process.cwd(), opts.workspace), ".agent-valley")),
          null,
          2,
        ),
      )
    })
  reports
    .command("retry")
    .option("--workspace <path>", "Source repository")
    .action(async (opts: { workspace?: string }) => {
      const config = mergeChiefConfig(loadGlobalConfig()?.chief, loadProjectConfig()?.chief)
      if (!config.reporting) throw new Error("Set chief.reporting.destinations in av.yaml before retrying reports.")
      console.log(
        JSON.stringify(
          await retryPendingReports(
            config.reporting,
            join(organizationRepository(process.cwd(), opts.workspace), ".agent-valley"),
          ),
          null,
          2,
        ),
      )
    })
}
