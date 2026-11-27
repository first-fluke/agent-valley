import { createHash } from "node:crypto"
import { z } from "zod"
import { MAX_CARGO_VERIFICATION_INPUTS } from "./cargo-verification"
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
import { jsonPointerValue, readVerificationFile, verificationBudget, verificationRoot } from "./verification-files"
import { nondeterministicTests } from "./verification-nondeterminism"

export type {
  VerificationCommandExecutor,
  VerificationCommandOptions,
  VerificationCommandOutput,
} from "./verification-command"
export * from "./verification-contract"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const inputSchema = z.strictObject({ path: z.string().min(1).max(1_024), sha256: digest })
export const checkEvidenceSchema = z.strictObject({
  checkSha256: digest,
  kind: z.enum(["file", "json", "command"]),
  passed: z.boolean(),
  summary: z.string().min(1).max(2_000),
  path: z.string().min(1).max(1_024).optional(),
  sha256: digest.optional(),
  outputSha256: digest.optional(),
  exitCode: z.number().int().nullable().optional(),
  /** Tests that failed in one run and passed in another: the command passed although every run exited non-zero. */
  nondeterministic: z.array(z.string().min(1).max(400)).min(1).max(40).optional(),
  inputs: z.array(inputSchema).max(MAX_CARGO_VERIFICATION_INPUTS).optional(),
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
        waived: z.boolean().optional(),
        // Evidence mirrors the contract: one record per contract check, so the limits must match.
        checks: z.array(checkEvidenceSchema).min(1).max(20),
      }),
    )
    .min(1)
    .max(20),
})

export type GoalVerificationResult = z.infer<typeof goalVerificationResultSchema>
export type CheckEvidence = z.infer<typeof checkEvidenceSchema>

/**
 * Passing command evidence the integration check observed, bound to the workspace fingerprint it ran on.
 * Verification may reuse it only while the workspace still has that fingerprint.
 */
export const integrationEvidenceSchema = z.strictObject({
  fingerprint: z.string().min(1).max(200),
  checkedAt: z.string().datetime(),
  checks: z.array(checkEvidenceSchema).min(1).max(40),
})
export type IntegrationEvidence = z.infer<typeof integrationEvidenceSchema>

/**
 * Passing command evidence from the most recent fully passing goal verification, bound to its
 * workspace fingerprint and contract SHA-256 so doc-only repairs can skip redundant command reruns.
 */
export const verificationBaselineSchema = z.strictObject({
  fingerprint: z.string().min(1).max(200),
  contractSha256: digest,
  checkedAt: z.string().datetime(),
  checks: z.array(checkEvidenceSchema).min(1).max(40),
})
export type VerificationBaseline = z.infer<typeof verificationBaselineSchema>

export interface GoalVerificationOptions {
  successCriteria: string[]
  expectedContractSha256?: string
  signal?: AbortSignal
  /**
   * Operator per-check timeout. When present it governs every contract command: the contract's
   * own timeoutMs is a planning-time estimate made before any check was measured.
   */
  timeoutMs?: number
  executeCommand?: VerificationCommandExecutor
  onSpawned?: (pid: number, detached: boolean) => void
  now?: () => Date
  /**
   * Passing command evidence already observed on this exact workspace state. A matching command whose
   * bound inputs are unchanged is not executed again; the caller guarantees the workspace is identical.
   */
  reuse?: readonly CheckEvidence[]
  /** Optional explanation recorded in reused command check summaries. */
  reuseReason?: string
  /** How often a command that exited non-zero is run again on the unchanged workspace. Defaults to none. */
  commandReruns?: number
  /** Criteria the operator recorded as waived (still inspected and reported unmet, no longer blocking). */
  waivedCriteria?: ReadonlySet<string>
}

export const VERIFICATION_RERUNS_ENV = "AV_VERIFICATION_RERUNS"

/**
 * A command that fails once and passes when run again on byte-identical inputs has shown a nondeterministic
 * test, not a defect of the delivery. Without a second run that single failure reopened a finished task for
 * a repair that had nothing to repair and cost a whole round of Actor run, integration check and review.
 * The operator sets 0 to keep every failure final.
 */
export function verificationReruns(source: NodeJS.ProcessEnv = process.env): number {
  const raw = source[VERIFICATION_RERUNS_ENV]?.trim()
  if (!raw) return 1
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 1
}

export function checkDigest(check: GoalVerificationCheck): string {
  return createHash("sha256").update(JSON.stringify(check)).digest("hex")
}

/**
 * Whether persisted command evidence represents a verified pass: either the command exited zero,
 * or every failing test across reruns passed in another run on the unchanged workspace (`nondeterministic`).
 */
export function isPassingCommandEvidence(entry: CheckEvidence): boolean {
  return (
    entry.kind === "command" &&
    entry.passed &&
    Boolean(entry.outputSha256) &&
    (entry.exitCode === 0 || Boolean(entry.nondeterministic?.length))
  )
}

const FAILURE_LINE = /FAILED|panicked at|^failures:|^error(?:\[|:)|\(fail\)|AssertionError|assertion .*failed|✗|×/

/**
 * Test runners report which test failed on stdout (libtest, Bun, Vitest) and only progress on stderr.
 * A stderr-only tail told the repairing Actor that a suite failed without naming the test, so it reran
 * the suite locally, saw it pass and resubmitted. Lead with the failing lines, then both stream tails.
 */
export function commandFailureDetail(stdout: string, stderr: string): string {
  const failing = stdout
    .split("\n")
    .filter((line) => FAILURE_LINE.test(line))
    .slice(-12)
    .map((line) => line.slice(0, 200))
    .join("\n")
  const parts = [
    failing ? `Failing output:\n${failing}` : "",
    stdout.trim() ? `stdout tail:\n${stdout.slice(-500)}` : "",
    stderr.trim() ? `stderr tail:\n${stderr.slice(-400)}` : "",
  ].filter(Boolean)
  return parts.join("\n").slice(0, 1_800)
}

function checkSummary(passed: boolean, detail: string): string {
  return `${passed ? "PASS" : "FAIL"}: ${detail}`.slice(0, 2_000)
}

const shown = (value: unknown) => (value === undefined ? "no value" : JSON.stringify(value).slice(0, 200))

/** Name the file and each unmet assertion so the repairing Actor does not have to rediscover them. */
export function fileFailureDetail(
  check: { path: string; minBytes: number; sha256?: string; contains?: readonly string[] },
  observed: { bytes: number; sha256: string; text: string },
): string {
  const unmet = [
    observed.bytes < check.minBytes ? `has ${observed.bytes} bytes, needs at least ${check.minBytes}` : "",
    check.sha256 !== undefined && check.sha256 !== observed.sha256
      ? `has SHA-256 ${observed.sha256}, needs ${check.sha256}`
      : "",
    ...(check.contains ?? [])
      .filter((part) => !observed.text.includes(part))
      .slice(0, 5)
      .map((part) => `lacks required text ${shown(part.slice(0, 120))}`),
  ].filter(Boolean)
  return `${check.path} ${unmet.join("; ")}.`
}

export function jsonFailureDetail(
  check: { path: string; pointer: string; equals: unknown },
  observed: unknown,
): string {
  return `${check.path} pointer ${check.pointer || "(root)"} must equal ${shown(check.equals)}; observed ${shown(observed)}.`
}

/** Persisted observations cannot omit checks or alter their bound contract. */
export function validateGoalVerificationResult(
  input: unknown,
  contract: GoalVerificationContract,
  waivedCriteria?: ReadonlySet<string>,
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
    if (evidence.waived === true && (evidence.passed || !waivedCriteria?.has(evidence.criterion)))
      throw new Error(
        "Verification evidence marks a criterion waived without a matching unmet operator waiver. Restore the saved waiver or rerun verification.",
      )
    for (const [checkIndex, check] of criterion.checks.entries()) {
      const observed = evidence.checks[checkIndex]
      if (
        !observed ||
        observed.checkSha256 !== checkDigest(check) ||
        observed.kind !== check.kind ||
        (check.kind !== "command" && observed.path !== check.path) ||
        (observed.passed && check.kind !== "command" && !observed.sha256) ||
        (observed.passed && check.kind === "file" && check.sha256 !== undefined && check.sha256 !== observed.sha256) ||
        (observed.passed && check.kind === "command" && !isPassingCommandEvidence(observed))
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
  if (result.ok !== result.evidence.every((entry) => entry.passed || entry.waived === true))
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
    const sha256 = checkDigest(check)
    const earlier = options.reuse?.find(
      (entry) =>
        isPassingCommandEvidence(entry) &&
        entry.checkSha256 === sha256 &&
        JSON.stringify(entry.inputs ?? []) === JSON.stringify(inputs),
    )
    if (earlier) {
      const nondeterministic = earlier.nondeterministic?.length ? earlier.nondeterministic : undefined
      const nondeterministicNote = nondeterministic
        ? ` NONDETERMINISTIC: ${nondeterministic.slice(0, 12).join(", ")}${nondeterministic.length > 12 ? ` and ${nondeterministic.length - 12} more` : ""}.`
        : ""
      const baseReason =
        options.reuseReason ??
        (nondeterministic
          ? `Explicit command passed via nondeterministic rerun (exit ${earlier.exitCode}) in the integration check on this identical workspace; its evidence is reused.`
          : "Explicit command exited zero in the integration check on this identical workspace; its evidence is reused.")
      return {
        passed: true,
        summary: checkSummary(true, `${baseReason}${nondeterministicNote}`),
        exitCode: earlier.exitCode,
        ...(nondeterministic ? { nondeterministic } : {}),
        outputSha256: earlier.outputSha256,
        inputs,
      }
    }
    const run = async () => {
      const result = await (options.executeCommand ?? executeVerificationCommand)(check.program, check.args, {
        cwd: root,
        timeoutMs: options.timeoutMs ?? check.timeoutMs,
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
      return result
    }
    let result = await run()
    // Only a process that ran to a non-zero exit is run again: a timeout or a kill would cost its full budget twice.
    const earlierFailures: string[] = []
    const failedRuns: (typeof result)[] = []
    for (let rerun = 0; rerun < (options.commandReruns ?? 0); rerun++) {
      if (result.exitCode === null || result.exitCode === 0 || options.signal?.aborted) break
      earlierFailures.push(`exit ${result.exitCode}: ${commandFailureDetail(result.stdout, result.stderr)}`)
      failedRuns.push(result)
      result = await run()
    }
    // Every run failed, each in other tests: no test failed twice, so none is a defect of this delivery.
    const unstable = result.exitCode === 0 ? undefined : nondeterministicTests([...failedRuns, result])
    const passed =
      (result.exitCode === 0 || unstable !== undefined) &&
      (check.stdoutIncludes ?? []).every((text) => result.stdout.includes(text))
    const nondeterministic =
      passed && earlierFailures.length > 0
        ? ` NONDETERMINISTIC: it failed ${earlierFailures.length} earlier run(s) on this unchanged workspace and is not a defect of this delivery; stabilise the named test in a later change. Earlier failure: ${earlierFailures[0]?.slice(0, 900)}`
        : ""
    return {
      passed,
      summary: checkSummary(
        passed,
        passed && unstable
          ? `Explicit command exited ${result.exitCode} in each of ${failedRuns.length + 1} runs, but no test failed in every run: each failing test passed in another run on this unchanged workspace. NONDETERMINISTIC: ${unstable.slice(0, 12).join(", ")}${unstable.length > 12 ? ` and ${unstable.length - 12} more` : ""}. They are not defects of this delivery; stabilise them in a later change.`
          : result.exitCode !== 0
            ? `Process exited ${result.exitCode ?? "without an exit code"}${earlierFailures.length > 0 ? ` in each of ${earlierFailures.length + 1} runs` : ""}. Repair the explicit test or Git check. ${commandFailureDetail(result.stdout, result.stderr)}`
            : passed
              ? `Explicit command exited zero and its required output assertions passed.${nondeterministic}`
              : "Process exited zero but required stdout assertions are missing.",
      ),
      exitCode: result.exitCode,
      ...(passed && unstable ? { nondeterministic: unstable.slice(0, 40).map((name) => name.slice(0, 400)) } : {}),
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
          : fileFailureDetail(check, { bytes: file.bytes.length, sha256: file.sha256, text }),
      ),
    }
  }
  let json: unknown
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  } catch {
    return {
      ...common,
      passed: false,
      summary: checkSummary(false, `${check.path} is not valid UTF-8 JSON.`),
    }
  }
  const observed = jsonPointerValue(json, check.pointer)
  // Scalars compare by identity; an array of scalars compares element-wise in order.
  const passed = Array.isArray(check.equals)
    ? Array.isArray(observed) &&
      observed.length === check.equals.length &&
      check.equals.every((expected, index) => Object.is(observed[index], expected))
    : Object.is(observed, check.equals)
  return {
    ...common,
    passed,
    summary: checkSummary(
      passed,
      passed ? "Observed JSON pointer equals its required value." : jsonFailureDetail(check, observed),
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
  const budget = verificationBudget()
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
    const passed = checks.every((check) => check.passed)
    const waived = !passed && Boolean(options.waivedCriteria?.has(criterion.criterion))
    evidence.push({ criterion: criterion.criterion, passed, ...(waived ? { waived: true } : {}), checks })
  }
  const output = evidence
    .map((entry) => {
      const label = entry.passed ? "PASS" : entry.waived ? "WAIVED (UNMET)" : "FAIL"
      return `${label} ${entry.criterion}\n${entry.checks.map((check) => check.summary).join("\n")}`
    })
    .join("\n\n")
    .slice(0, 32_000)
  return validateGoalVerificationResult(
    {
      ok: evidence.every((entry) => entry.passed || entry.waived === true),
      output,
      contractSha256,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      evidence,
    },
    contract,
    options.waivedCriteria,
  )
}

/**
 * Run only the contract's command checks. Used between task waves, where evidence files of later tasks do
 * not exist yet: it tells reviewers what the integrated tree actually does without judging completion.
 */
export async function executeCommandChecks(
  input: unknown,
  workspaceRoot: string,
  options: GoalVerificationOptions,
): Promise<{ ok: boolean; output: string; evidence: CheckEvidence[] } | undefined> {
  const contract = validateGoalVerificationContract(input, options.successCriteria)
  const commands = new Map<string, Extract<GoalVerificationCheck, { kind: "command" }>>()
  for (const criterion of contract.criteria)
    for (const check of criterion.checks)
      if (check.kind === "command") commands.set(JSON.stringify([check.program, check.args]), check)
  if (!commands.size) return undefined
  const root = await verificationRoot(workspaceRoot)
  const budget = verificationBudget()
  const lines: string[] = []
  const evidence: CheckEvidence[] = []
  let ok = true
  for (const check of commands.values()) {
    if (options.signal?.aborted) throw new Error("Integration check interrupted. Resume the mission to rerun it.")
    const label = [check.program, ...check.args].join(" ").slice(0, 300)
    try {
      const observed = await inspectCheck(check, root, options, budget)
      ok &&= observed.passed
      evidence.push({ checkSha256: checkDigest(check), kind: check.kind, ...observed })
      lines.push(`${label}\n${observed.summary}`)
    } catch (error) {
      if (options.signal?.aborted) throw error
      ok = false
      lines.push(`${label}\n${checkSummary(false, error instanceof Error ? error.message : "Check could not run.")}`)
    }
  }
  return { ok, output: lines.join("\n\n").slice(0, 8_000), evidence }
}
