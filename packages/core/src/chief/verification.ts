import { createHash } from "node:crypto"
import { z } from "zod"
import {
  executeVerificationCommand,
  MAX_VERIFICATION_OUTPUT_BYTES,
  type VerificationCommandExecutor,
  verificationCommandInputs,
} from "./verification-command"
import {
  type GoalVerificationCheck,
  type GoalVerificationContract,
  goalVerificationContractDigest,
  safeVerificationPath,
  validateGoalVerificationContract,
  verificationCommandTestPaths,
} from "./verification-contract"
import {
  jsonPointerValue,
  MAX_VERIFICATION_TOTAL_BYTES,
  readVerificationFile,
  verificationRoot,
} from "./verification-files"

export type {
  VerificationCommandExecutor,
  VerificationCommandOptions,
  VerificationCommandOutput,
} from "./verification-command"
export * from "./verification-contract"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const inputSchema = z.strictObject({ path: z.string().min(1).max(1_024), sha256: digest })
const checkEvidenceSchema = z.strictObject({
  checkSha256: digest,
  kind: z.enum(["file", "json", "command"]),
  passed: z.boolean(),
  summary: z.string().min(1).max(2_000),
  path: z.string().min(1).max(1_024).optional(),
  sha256: digest.optional(),
  outputSha256: digest.optional(),
  exitCode: z.number().int().nullable().optional(),
  inputs: z.array(inputSchema).max(30).optional(),
})

export const goalVerificationResultSchema = z.strictObject({
  ok: z.boolean(),
  output: z.string().max(32_000),
  contractSha256: digest,
  checkedAt: z.string().datetime(),
  evidence: z
    .array(
      z.strictObject({
        criterion: z.string().min(1).max(4_000),
        passed: z.boolean(),
        checks: z.array(checkEvidenceSchema).min(1).max(10),
      }),
    )
    .min(1)
    .max(20),
})

export type GoalVerificationResult = z.infer<typeof goalVerificationResultSchema>
type CheckEvidence = z.infer<typeof checkEvidenceSchema>

export interface GoalVerificationOptions {
  successCriteria: string[]
  expectedContractSha256?: string
  signal?: AbortSignal
  /** Upper bound applied to each contract command timeout. */
  timeoutMs?: number
  executeCommand?: VerificationCommandExecutor
  onSpawned?: (pid: number, detached: boolean) => void
  now?: () => Date
}

function checkDigest(check: GoalVerificationCheck): string {
  return createHash("sha256").update(JSON.stringify(check)).digest("hex")
}

function checkSummary(passed: boolean, detail: string): string {
  return `${passed ? "PASS" : "FAIL"}: ${detail}`.slice(0, 2_000)
}

/** Persisted observations cannot omit checks or alter their bound contract. */
export function validateGoalVerificationResult(
  input: unknown,
  contract: GoalVerificationContract,
): GoalVerificationResult {
  const result = goalVerificationResultSchema.parse(input)
  if (
    result.contractSha256 !== goalVerificationContractDigest(contract) ||
    result.evidence.length !== contract.criteria.length
  )
    throw new Error("Verification evidence belongs to another contract. Rerun the original verification checks.")
  for (const [index, criterion] of contract.criteria.entries()) {
    const evidence = result.evidence[index]
    if (
      !evidence ||
      evidence.criterion !== criterion.criterion ||
      evidence.checks.length !== criterion.checks.length ||
      evidence.passed !== evidence.checks.every((check) => check.passed)
    )
      throw new Error("Verification evidence omits or changes an original criterion. Rerun all its checks.")
    for (const [checkIndex, check] of criterion.checks.entries()) {
      const observed = evidence.checks[checkIndex]
      if (
        !observed ||
        observed.checkSha256 !== checkDigest(check) ||
        observed.kind !== check.kind ||
        (check.kind !== "command" && observed.path !== check.path) ||
        (observed.passed && check.kind !== "command" && !observed.sha256) ||
        (observed.passed && check.kind === "file" && check.sha256 !== undefined && check.sha256 !== observed.sha256) ||
        (observed.passed && check.kind === "command" && (observed.exitCode !== 0 || !observed.outputSha256))
      )
        throw new Error(
          "Verification check lacks bound file or process evidence. Rerun it against the actual worktree.",
        )
      if (observed.passed && check.kind === "command") {
        const tests = verificationCommandTestPaths(check.program, check.args)
        if (
          tests.some((path) => !observed.inputs?.some((entry) => entry.path === path)) ||
          observed.inputs?.some((entry) => !safeVerificationPath(entry.path))
        )
          throw new Error("Verification process evidence omits its actual test inputs. Rerun the original tests.")
      }
    }
  }
  if (result.ok !== result.evidence.every((entry) => entry.passed))
    throw new Error("Verification completion must match every actual evidence check.")
  return result
}

async function inspectCheck(
  check: GoalVerificationCheck,
  root: string,
  options: GoalVerificationOptions,
  budget: { remaining: number },
): Promise<Omit<CheckEvidence, "checkSha256" | "kind">> {
  if (check.kind === "command") {
    const inputs = await verificationCommandInputs(root, check.program, check.args, budget)
    const result = await (options.executeCommand ?? executeVerificationCommand)(check.program, check.args, {
      cwd: root,
      timeoutMs: Math.min(check.timeoutMs, options.timeoutMs ?? check.timeoutMs),
      maxOutputBytes: MAX_VERIFICATION_OUTPUT_BYTES,
      signal: options.signal,
      onSpawned: options.onSpawned,
    })
    if (
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      (result.exitCode !== null && !Number.isInteger(result.exitCode)) ||
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > MAX_VERIFICATION_OUTPUT_BYTES
    )
      throw new Error("Verification command returned malformed or oversized output. Rerun its bounded process.")
    const after = await verificationCommandInputs(root, check.program, check.args, budget)
    if (JSON.stringify(inputs) !== JSON.stringify(after))
      throw new Error("Verification test inputs changed during execution. Stop concurrent writers and rerun tests.")
    const passed = result.exitCode === 0 && (check.stdoutIncludes ?? []).every((text) => result.stdout.includes(text))
    return {
      passed,
      summary: checkSummary(
        passed,
        result.exitCode !== 0
          ? `Process exited ${result.exitCode ?? "without an exit code"}. Repair the explicit test or Git check. ${(result.stderr || result.stdout).slice(-1_200)}`
          : passed
            ? "Explicit command exited zero and its required output assertions passed."
            : "Process exited zero but required stdout assertions are missing.",
      ),
      exitCode: result.exitCode,
      outputSha256: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
      inputs,
    }
  }
  const file = await readVerificationFile(root, check.path, budget)
  const common = { path: check.path, sha256: file.sha256 }
  if (check.kind === "file") {
    const text = check.contains ? new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) : ""
    const passed =
      file.bytes.length >= check.minBytes &&
      (check.sha256 === undefined || check.sha256 === file.sha256) &&
      (check.contains ?? []).every((part) => text.includes(part))
    return {
      ...common,
      passed,
      summary: checkSummary(
        passed,
        passed
          ? "Regular file satisfies its byte/content/hash assertions."
          : "File byte/content/hash assertions are unmet.",
      ),
    }
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  } catch {
    return { ...common, passed: false, summary: checkSummary(false, "Observed file is not valid UTF-8 JSON.") }
  }
  const passed = Object.is(jsonPointerValue(json, check.pointer), check.equals)
  return {
    ...common,
    passed,
    summary: checkSummary(
      passed,
      passed
        ? "Observed JSON pointer equals its required scalar."
        : "Observed JSON pointer is missing or has a different value.",
    ),
  }
}

/** Checks inspect real bytes and process results; Actor claims are never evidence inputs. */
export async function executeGoalVerification(
  input: unknown,
  workspaceRoot: string,
  options: GoalVerificationOptions,
): Promise<GoalVerificationResult> {
  const contract = validateGoalVerificationContract(input, options.successCriteria)
  const contractSha256 = goalVerificationContractDigest(contract)
  if (options.expectedContractSha256 && options.expectedContractSha256 !== contractSha256)
    throw new Error(
      "Chief Director verification contract changed. Restore the immutable original checks before resuming.",
    )
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1))
    throw new Error("Verification timeout must be a positive bounded duration.")
  const root = await verificationRoot(workspaceRoot)
  const budget = { remaining: MAX_VERIFICATION_TOTAL_BYTES }
  const evidence: GoalVerificationResult["evidence"] = []
  for (const criterion of contract.criteria) {
    const checks: CheckEvidence[] = []
    for (const check of criterion.checks) {
      if (options.signal?.aborted) throw new Error("Verification interrupted. Resume the mission to rerun its checks.")
      let observed: Omit<CheckEvidence, "checkSha256" | "kind">
      try {
        observed = await inspectCheck(check, root, options, budget)
      } catch (error) {
        if (options.signal?.aborted) throw error
        observed = {
          passed: false,
          summary: checkSummary(
            false,
            error instanceof Error
              ? error.message
              : "Evidence could not be inspected. Restore the expected file or test.",
          ),
          ...(check.kind === "command" ? {} : { path: check.path }),
        }
      }
      checks.push({ checkSha256: checkDigest(check), kind: check.kind, ...observed })
    }
    evidence.push({ criterion: criterion.criterion, passed: checks.every((check) => check.passed), checks })
  }
  const output = evidence
    .map(
      (entry) =>
        `${entry.passed ? "PASS" : "FAIL"} ${entry.criterion}\n${entry.checks.map((check) => check.summary).join("\n")}`,
    )
    .join("\n\n")
    .slice(0, 32_000)
  return validateGoalVerificationResult(
    {
      ok: evidence.every((entry) => entry.passed),
      output,
      contractSha256,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      evidence,
    },
    contract,
  )
}
