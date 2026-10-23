import { constants } from "node:fs"
import { open } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { type A2aJob, a2aEndpointSchema } from "@agent-valley/core/executions/a2a-job"
import {
  listA2aExecutions,
  reconcileA2aExecution,
  resumeA2aExecution,
  startA2aExecution,
} from "@agent-valley/core/executions/a2a-service"
import type { Command } from "commander"
import { assertNotManagedRun } from "./managed-run"

interface WorkspaceOptions {
  workspace?: string
}
interface RunOptions extends WorkspaceOptions {
  endpoint: string
  allow: string[]
  verify: string
  timeout: string
  promptFile?: string
}

function workspace(options: WorkspaceOptions, root: string): string {
  const directory = options.workspace ?? root
  if (!isAbsolute(directory)) throw new Error("--workspace must be an absolute Git repository path.")
  return directory
}

async function readText(path: string, label: string, limit: number): Promise<string> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit)
      throw new Error(`${label} must be a regular file no larger than ${limit} bytes.`)
    const bytes = await file.readFile()
    if (bytes.length > limit) throw new Error(`${label} exceeds ${limit} bytes. Reduce the file and retry.`)
    return bytes.toString("utf8")
  } finally {
    await file.close()
  }
}

async function readEndpoint(path: string) {
  let raw: unknown
  const content = await readText(path, "Endpoint JSON", 65_536)
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error("Invalid endpoint JSON. Supply a JSON object with id, url and optional authTokenEnv.")
  }
  const result = a2aEndpointSchema.safeParse(raw)
  if (!result.success) {
    const paths = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "endpoint"))]
    throw new Error(
      `Invalid A2A endpoint configuration at ${paths.join(", ")}. Use the supported endpoint fields and an environment variable name in authTokenEnv; inline credentials are not accepted.`,
    )
  }
  return result.data
}

async function withSignals(run: (signal: AbortSignal) => Promise<A2aJob>): Promise<A2aJob> {
  const controller = new AbortController()
  const abort = () => controller.abort(new Error("A2A execution interrupted. Inspect its saved ID before resuming."))
  process.on("SIGINT", abort)
  process.on("SIGTERM", abort)
  try {
    return await run(controller.signal)
  } finally {
    process.removeListener("SIGINT", abort)
    process.removeListener("SIGTERM", abort)
  }
}

function printJob(job: A2aJob): void {
  console.log(
    JSON.stringify({
      id: job.id,
      status: job.status,
      endpoint: job.endpoint.id,
      ...(job.checkpoint
        ? {
            phase: job.checkpoint.phase,
            ...(job.checkpoint.state ? { remoteState: job.checkpoint.state } : {}),
            ...(job.checkpoint.taskId ? { taskId: job.checkpoint.taskId } : {}),
            ...(job.checkpoint.contextId ? { contextId: job.checkpoint.contextId } : {}),
          }
        : {}),
      verified: job.verification?.ok ?? false,
    }),
  )
}

function finish(job: A2aJob): void {
  printJob(job)
  process.exitCode = job.status === "completed" ? 0 : 1
}

export function registerA2aCommands(program: Command, root = process.cwd()): void {
  const a2a = program.command("a2a").description("Run and reconcile durable remote A2A executions")
  a2a
    .command("run [goal]")
    .description("Submit a goal with a pinned endpoint, allowed paths and local verification")
    .requiredOption("--endpoint <file>", "Endpoint JSON file; credentials are referenced by environment variable name")
    .option(
      "--allow <path>",
      "Allowed repository path; repeat for each permitted path",
      (value, prior: string[]) => [...prior, value],
      [],
    )
    .requiredOption("--verify <command>", "Trusted local command that must pass after artifact application")
    .option("--prompt-file <file>", "Read the goal from a UTF-8 file instead of the goal argument")
    .option("--timeout <seconds>", "Execution timeout from 1 to 86400 seconds", "600")
    .option("--workspace <path>", "Absolute Git repository path (default current directory)")
    .action(async (goal: string | undefined, options: RunOptions) => {
      assertNotManagedRun()
      const directory = workspace(options, root)
      if ((goal !== undefined) === (options.promptFile !== undefined))
        throw new Error("Provide exactly one goal argument or --prompt-file <file>.")
      const prompt = (
        options.promptFile ? await readText(options.promptFile, "Prompt file", 256_000) : (goal ?? "")
      ).trim()
      if (!prompt || prompt.length > 64_000) throw new Error("The goal must contain 1–64000 characters.")
      if (!options.allow.length)
        throw new Error("Set --allow <path> for every repository path the remote task may change.")
      if (!options.verify.trim()) throw new Error("Set --verify to a nonempty trusted local verification command.")
      const timeoutSec = Number(options.timeout)
      if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 86_400)
        throw new Error("--timeout must be an integer from 1 to 86400 seconds.")
      const endpoint = await readEndpoint(options.endpoint)
      finish(
        await withSignals((signal) =>
          startA2aExecution(
            {
              root: directory,
              goal: prompt,
              endpoint,
              allowedPaths: options.allow,
              verifyCommand: options.verify,
              timeoutSec,
            },
            signal,
            (job) => console.log(`A2A execution ${job.id}`),
          ),
        ),
      )
    })
  a2a
    .command("resume <id>")
    .description("Continue the saved execution and its original verification contract")
    .option("--workspace <path>", "Absolute repository containing the saved execution (default current directory)")
    .action(async (id: string, options: WorkspaceOptions) => {
      assertNotManagedRun()
      finish(await withSignals((signal) => resumeA2aExecution(workspace(options, root), id, signal)))
    })
  a2a
    .command("status [id]")
    .description("Show execution IDs, runtime state and verification status")
    .option("--workspace <path>", "Absolute repository containing saved executions (default current directory)")
    .action(async (id: string | undefined, options: WorkspaceOptions) => {
      const jobs = await listA2aExecutions(workspace(options, root))
      const selected = id ? jobs.filter((job) => job.id === id) : jobs
      if (id && !selected.length) throw new Error("A2A execution not found. Use av a2a status to list saved IDs.")
      for (const job of selected) printJob(job)
      if (!selected.length) console.log("No A2A executions.")
      process.exitCode = selected.every((job) => job.status === "completed") ? 0 : 1
    })
  a2a
    .command("reconcile <id>")
    .description("Record independently checked termination evidence for an uncertain execution")
    .requiredOption("--evidence <text>", "Observed termination evidence, up to 2,000 characters")
    .option("--workspace <path>", "Absolute repository containing the saved execution (default current directory)")
    .action(async (id: string, options: WorkspaceOptions & { evidence: string }) => {
      assertNotManagedRun()
      if (!options.evidence.trim() || options.evidence.trim().length > 2_000)
        throw new Error("--evidence must contain 1–2,000 characters describing how termination was confirmed.")
      finish(await reconcileA2aExecution(workspace(options, root), id, options.evidence.trim()))
    })
}
