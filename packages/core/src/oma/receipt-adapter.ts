/** OMA v1 receipt adapter. Strict mode verifies the installed CLI's actual contract. */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { getCachedTriggerTable, routeIssue } from "../config/workflow-router"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import { ensureLatestOmaCli, type OmaLatestCliIO, parseOmaCliVersion } from "./latest-cli"
import { listOmaRunFiles, OMA_RUN_ID, type OmaReceiptStorageOptions, resolveOmaReceiptPath } from "./receipt-storage"

export { parseOmaCliVersion } from "./latest-cli"

export const OMA_RECEIPT_SCHEMA_VERSION = 1
const HASH = /^[a-f0-9]{64}$/

export interface OmaEvidenceRequest {
  issue: Issue
  attempt: RunAttempt
  workspace: Workspace
  agentId: string
  verifyCommand: string
  kind: "code" | "analysis"
  reportPath?: string
}

export interface OmaEvidenceResult {
  ok: boolean
  reason?: string
  runId?: string
}

export interface OmaEvidenceIO {
  listRunFiles: (workspacePath: string) => string[]
  resolveRunFile?: (workspacePath: string, entry: string) => string
  readReceipt: (path: string) => string
  runCli: (args: string[], cwd: string) => { exitCode: number | null; stdout: string }
}

export function createOmaEvidenceIO(options: OmaReceiptStorageOptions = {}): OmaEvidenceIO {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), OMA_SKIP_VERSION_CHECK: "1" }
  if (options.home !== undefined && !env.OMA_HOME) env.OMA_HOME = join(options.home, ".oma")
  const storage = { ...options, env }
  return {
    listRunFiles: (workspacePath) => listOmaRunFiles(workspacePath, storage),
    resolveRunFile: (workspacePath, entry) => resolveOmaReceiptPath(workspacePath, entry, storage),
    readReceipt: (path) => {
      if (!lstatSync(path).isFile()) throw new Error("Receipt is not a regular file")
      return readFileSync(path, "utf-8")
    },
    runCli: (args, cwd) => {
      const result = spawnSync("oma", args, {
        cwd,
        env,
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      })
      if (result.error) throw result.error
      return { exitCode: result.status, stdout: result.stdout }
    },
  }
}

function fail(reason: string): OmaEvidenceResult {
  return { ok: false, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/** Valley writes the acceptance contract before the agent starts. The agent
 * may write its claim, but cannot choose or weaken required checks. */
export async function prepareOmaAttempt(
  request: Omit<OmaEvidenceRequest, "kind">,
  dependencies: { latestCliIO?: OmaLatestCliIO } = {},
): Promise<string> {
  if (!request.verifyCommand.trim()) {
    throw new Error("oma.mode: strict requires verify.command in av.yaml or a routing verify_command")
  }
  const table = getCachedTriggerTable(request.workspace.path)
  if (!table) {
    throw new Error("Strict OMA mode requires a compatible .agents/hooks/core/triggers.json in the target worktree")
  }
  const routed = routeIssue(`${request.issue.title}\n${request.issue.description ?? ""}`, table)
  for (const workflow of routed.workflows) {
    const file = join(request.workspace.path, ".agents", "workflows", `${workflow}.md`)
    if (!existsSync(file)) throw new Error(`OMA workflow file missing in target worktree: ${file}`)
  }
  await ensureLatestOmaCli({ io: dependencies.latestCliIO })
  const path = join(request.workspace.path, ".agents", "results", `plan-${request.attempt.id}.json`)
  const plan = {
    session_id: request.attempt.id,
    lineage_id: request.attempt.id,
    valley_issue_id: request.issue.id,
    valley_workspace: resolve(request.workspace.path),
    tasks: [
      {
        id: request.attempt.id,
        dependencies: [],
        retry_policy: "manual",
        acceptance_criteria: [
          { id: "verified", description: "Configured project verification passed on current inputs" },
        ],
        required_checks: [
          {
            id: "valley-verify",
            criteria: ["verified"],
            command: ["sh", "-c", request.verifyCommand],
            cwd: ".",
          },
        ],
      },
    ],
  }
  await mkdir(join(request.workspace.path, ".agents", "results"), { recursive: true })
  await writeFile(path, JSON.stringify(plan, null, 2), { encoding: "utf-8", flag: "wx" })
  return path
}

export function buildOmaGuidance(request: Omit<OmaEvidenceRequest, "kind">): string {
  const root = shellQuote(request.workspace.path)
  const id = shellQuote(request.attempt.id)
  const agent = shellQuote(request.agentId)
  return [
    "## Required OMA result contract",
    "From the workspace root, start this exact run before work:",
    "```sh",
    `oma agent begin ${agent} ${id} ${id} --project-root ${root} --workspace ${root}`,
    "```",
    "Save the JSON runId and claimPath from that command. Commit code changes before verification.",
    "Run the pinned check, replacing RUN_ID with the returned runId:",
    "```sh",
    `oma agent verify RUN_ID --required --project-root ${root}`,
    "```",
    'Write the claimPath JSON with {"status":"completed","changedFiles":["relative/changed/file"],"unresolved":[],"artifacts":[]}. For analysis, use changedFiles: [] and put relative report paths in artifacts.',
    "Finish the run, replacing RUN_ID and CLAIM_PATH with the returned values:",
    "```sh",
    `oma agent finish RUN_ID CLAIM_PATH --project-root ${root}`,
    "```",
    request.reportPath
      ? `For analysis, include the report ${request.reportPath.replaceAll("{{attempt.id}}", request.attempt.id)} in artifacts; a promise in stdout is not completion evidence.`
      : "For analysis, include the configured current-attempt report in artifacts; a promise in stdout is not completion evidence.",
  ].join("\n")
}

/** Verify identity and check receipts, then ask OMA's read-only status command
 * to validate current workspace/contract/artifact hashes. A receipt file by
 * itself is never treated as proof. */
export function validateOmaEvidence(
  request: OmaEvidenceRequest,
  io: OmaEvidenceIO = createOmaEvidenceIO(),
): OmaEvidenceResult {
  const root = resolve(request.workspace.path)
  if (!request.verifyCommand.trim()) return fail("Strict OMA mode has no configured verify command")
  let cliVersion: string | null
  try {
    const version = io.runCli(["--version"], root)
    cliVersion = parseOmaCliVersion(version.stdout)
    if (version.exitCode !== 0 || !cliVersion) {
      return fail(
        "OMA CLI is unavailable or returned a malformed version. Run npm install -g oh-my-agent@latest, then confirm oma --version and rerun the receipt verification.",
      )
    }
  } catch (err) {
    return fail(`OMA CLI unavailable: ${String(err)}`)
  }

  let receipts: Record<string, unknown>[]
  const locations = new Map<Record<string, unknown>, string>()
  try {
    receipts = io.listRunFiles(root).map((entry) => {
      const name = basename(entry)
      const path = (io.resolveRunFile ?? resolveOmaReceiptPath)(root, entry)
      if (!OMA_RUN_ID.test(name.slice(0, -5)) || !name.endsWith(".json")) throw new Error("Invalid receipt filename")
      const parsed: unknown = JSON.parse(io.readReceipt(path))
      if (!isRecord(parsed) || parsed.runId !== name.slice(0, -5)) throw new Error("Malformed run receipt")
      locations.set(parsed, dirname(path))
      return parsed
    })
  } catch (err) {
    return fail(`Missing or malformed OMA receipt: ${String(err)}`)
  }
  const forAttempt = receipts.filter((run) => run.sessionId === request.attempt.id && run.agentId === request.agentId)
  if (forAttempt.some((run) => !Number.isSafeInteger(run.sequence) || Number(run.sequence) < 1))
    return fail("OMA receipt sequence is malformed")
  if (new Set(forAttempt.map((run) => run.sequence)).size !== forAttempt.length)
    return fail("OMA receipt sequence is ambiguous across matching runs")
  if (new Set(forAttempt.map((run) => locations.get(run))).size > 1)
    return fail(
      "Matching OMA receipts span multiple stores; generate current evidence in the active CLI's selected project/profile",
    )
  forAttempt.sort((a, b) => Number(a.sequence) - Number(b.sequence))
  const run = forAttempt.at(-1)
  if (!run) return fail("No OMA receipt is bound to this Valley attempt")
  if (run.schemaVersion !== OMA_RECEIPT_SCHEMA_VERSION) {
    return fail(
      `OMA CLI ${cliVersion} returned an unsupported receipt schema. AV requires agent-run schema v${OMA_RECEIPT_SCHEMA_VERSION}; update AV and OMA (npm install -g oh-my-agent@latest), then generate and verify a compatible receipt.`,
    )
  }
  if (run.taskId !== request.attempt.id || !OMA_RUN_ID.test(String(run.runId))) {
    return fail("OMA receipt task identity is incompatible")
  }
  if (run.workspace !== root || run.artifactRoot !== root || run.status !== "completed" || run.exitCode !== 0) {
    return fail("OMA receipt has the wrong workspace or did not complete")
  }
  const started = Date.parse(String(run.startedAt))
  const finished = Date.parse(String(run.finishedAt))
  const valleyStarted = Date.parse(request.attempt.startedAt)
  const valleyFinished = Date.parse(String(request.attempt.finishedAt))
  if (
    ![started, finished, valleyStarted, valleyFinished].every(Number.isFinite) ||
    started < valleyStarted ||
    finished < started ||
    finished > valleyFinished
  ) {
    return fail("OMA receipt is stale or outside this Valley attempt")
  }
  if (!stringArray(run.unresolved) || run.unresolved.length > 0 || run.verificationSkipped !== undefined) {
    return fail("OMA receipt has unresolved work or skipped verification")
  }
  if (!stringArray(run.changedFiles)) return fail("OMA changedFiles is malformed")
  if (run.changedFiles.some((name) => !name || name.startsWith("/") || name.split(/[\\/]/).includes(".."))) {
    return fail("OMA changedFiles includes a path outside the workspace")
  }
  if (request.kind === "code" && run.changedFiles.length === 0)
    return fail("Code completion has no declared changed files")
  if (request.kind === "analysis" && run.changedFiles.length > 0) {
    return fail("Analysis completion declares code changes that the workspace did not contain")
  }
  if (!HASH.test(String(run.before)) || (request.kind === "code" && run.before === run.after)) {
    return fail("Code completion has no changed product inputs bound to this run")
  }
  if (request.kind === "analysis") {
    const template = request.reportPath
    if (!template?.includes("{{attempt.id}}")) return fail("Analysis requires a configured current-attempt report path")
    const expanded = template.replaceAll("{{attempt.id}}", request.attempt.id)
    const target = resolve(root, expanded)
    const subpath = relative(root, target)
    if (
      isAbsolute(expanded) ||
      expanded.split(/[\\/]/).includes("..") ||
      subpath === "" ||
      subpath === ".." ||
      subpath.startsWith(`..${sep}`) ||
      isAbsolute(subpath)
    ) {
      return fail("Configured analysis report escapes the workspace")
    }
    if (
      !isRecord(run.artifacts) ||
      !Object.entries(run.artifacts).some(
        ([path, hash]) =>
          !isAbsolute(path) &&
          !path.split(/[\\/]/).includes("..") &&
          resolve(root, path) === target &&
          HASH.test(String(hash)),
      )
    ) {
      return fail("OMA receipt does not bind the configured current-attempt report")
    }
  }
  if (!HASH.test(String(run.after))) return fail("OMA receipt has no final input hash")
  const checks = isRecord(run.contract) ? run.contract.required_checks : undefined
  const required = Array.isArray(checks) ? checks : []
  if (
    required.length !== 1 ||
    !isRecord(required[0]) ||
    required[0].id !== "valley-verify" ||
    JSON.stringify(required[0].command) !== JSON.stringify(["sh", "-c", request.verifyCommand]) ||
    required[0].cwd !== "."
  ) {
    return fail("OMA receipt check contract differs from trusted av.yaml configuration")
  }
  if (!Array.isArray(run.checks)) return fail("OMA verification receipts are missing")
  const latestChecks = new Map<string, Record<string, unknown>>()
  for (const check of run.checks) {
    if (!isRecord(check) || !stringArray(check.command) || !check.command.length || typeof check.cwd !== "string")
      return fail("OMA verification receipt is malformed")
    latestChecks.set(JSON.stringify([check.command, resolve(check.cwd)]), check)
  }
  if (
    [...latestChecks.values()].some(
      (check) => check.exitCode !== 0 || check.before !== run.after || check.after !== run.after,
    )
  ) {
    return fail("An OMA verification check failed or is stale")
  }
  const lastCheck = latestChecks.get(JSON.stringify([["sh", "-c", request.verifyCommand], root]))
  if (
    !lastCheck ||
    lastCheck.checkId !== "valley-verify" ||
    lastCheck.exitCode !== 0 ||
    lastCheck.before !== run.after ||
    lastCheck.after !== run.after
  ) {
    return fail("Required OMA verification did not pass on current inputs")
  }
  try {
    const status = io.runCli(["agent", "status", request.attempt.id, request.agentId, "--project-root", root], root)
    if (status.exitCode !== 0 || status.stdout.trim() !== `${request.agentId}:completed`) {
      if (status.stdout.trim() !== `${request.agentId}:stale`)
        return fail(
          `OMA CLI ${cliVersion} did not provide the required native <agent>:completed status proof. Update AV and OMA (npm install -g oh-my-agent@latest), then rerun verification; unknown status output cannot establish completion.`,
        )
      return fail("OMA CLI did not confirm current completed evidence")
    }
  } catch (err) {
    return fail(`OMA CLI status validation failed: ${String(err)}`)
  }
  return { ok: true, runId: String(run.runId) }
}
