import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { type WorkspaceFileEntry, type WorkspaceManifest, workspaceFileManifest } from "../workspace/fingerprint"
import type { Mission } from "./types"
import {
  type CheckEvidence,
  checkDigest,
  type GoalVerificationCheck,
  type GoalVerificationContract,
  type GoalVerificationResult,
  goalVerificationContractDigest,
  safeVerificationPath,
  type VerificationBaseline,
  verificationCommandTestPaths,
} from "./verification"

const BASELINE_DIR = "verification-baselines"
const BASELINES_KEPT = 5
const MAX_BASELINE_BYTES = 8 * 1024 * 1024

const NON_DOC_SEGMENTS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "coverage",
  "test",
  "tests",
  "spec",
  "specs",
  "__tests__",
  "fixture",
  "fixtures",
  "__fixtures__",
  "testdata",
  "test-data",
  "snapshot",
  "snapshots",
  "__snapshots__",
  "mock",
  "mocks",
  "__mocks__",
  "script",
  "scripts",
  "bin",
  "config",
  "configs",
])

const NON_DOC_TXT_FILENAMES = new Set([
  "cmakelists.txt",
  "robots.txt",
  "humans.txt",
  "llms.txt",
  "requirements.txt",
  "constraints.txt",
])

const workspaceManifestSchema = z.strictObject({
  version: z.literal(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.record(
    z.string().min(1).max(1_024),
    z.strictObject({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      regularNonExec: z.boolean(),
    }),
  ),
})

/**
 * Conservative allowlist of non-executable documentation paths.
 * Never treats code, scripts, config, manifests, lockfiles, tests, fixtures, hidden/CI paths,
 * or build-system `.txt` files as doc-only.
 */
export function isDocOnlyPath(path: string): boolean {
  if (!safeVerificationPath(path)) return false
  const segments = path.split("/")
  if (segments.some((segment) => segment.startsWith("."))) return false
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]?.toLowerCase()
    if (!segment || NON_DOC_SEGMENTS.has(segment)) return false
  }
  const filename = segments[segments.length - 1]?.toLowerCase() ?? ""
  if (!filename.endsWith(".md") && !filename.endsWith(".mdx") && !filename.endsWith(".txt")) return false
  if (filename.endsWith(".txt")) {
    if (NON_DOC_TXT_FILENAMES.has(filename)) return false
    if (/^(?:requirements|constraints|pip)[-_].*\.txt$/.test(filename)) return false
    if (/^.*[-_](?:requirements|constraints)\.txt$/.test(filename)) return false
  }
  return true
}

export interface WorkspaceManifestDiffEntry {
  path: string
  prev?: WorkspaceFileEntry
  curr?: WorkspaceFileEntry
}

export function diffWorkspaceManifests(
  previous: WorkspaceManifest,
  current: WorkspaceManifest,
): WorkspaceManifestDiffEntry[] {
  const paths = new Set([...Object.keys(previous.files), ...Object.keys(current.files)])
  const changed: WorkspaceManifestDiffEntry[] = []
  for (const path of [...paths].sort()) {
    const prev = previous.files[path]
    const curr = current.files[path]
    if (!prev || !curr || prev.sha256 !== curr.sha256 || prev.regularNonExec !== curr.regularNonExec) {
      changed.push({ path, ...(prev ? { prev } : {}), ...(curr ? { curr } : {}) })
    }
  }
  return changed
}

export async function saveVerificationBaselineManifest(
  workspacePath: string,
  manifest: WorkspaceManifest,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(manifest.fingerprint)) return
  try {
    const directory = join(workspacePath, ".agent-valley", BASELINE_DIR)
    await mkdir(directory, { recursive: true })
    const filePath = join(directory, `${manifest.fingerprint}.json`)
    const payload = JSON.stringify({ version: 1, fingerprint: manifest.fingerprint, files: manifest.files })
    await writeFile(filePath, payload, { encoding: "utf8", mode: 0o600 })
    const earlier = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()
    const keep = `${manifest.fingerprint}.json`
    const prune = earlier.filter((name) => name !== keep)
    for (const name of prune.slice(0, Math.max(0, prune.length - (BASELINES_KEPT - 1)))) {
      await rm(join(directory, name), { force: true })
    }
  } catch {
    // Baseline persistence is an optimization; failures fall back to full verification.
  }
}

export async function loadVerificationBaselineManifest(
  workspacePath: string,
  fingerprint: string,
): Promise<WorkspaceManifest | undefined> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return undefined
  try {
    const filePath = join(workspacePath, ".agent-valley", BASELINE_DIR, `${fingerprint}.json`)
    const raw = await readFile(filePath, "utf8")
    if (Buffer.byteLength(raw, "utf8") > MAX_BASELINE_BYTES) return undefined
    const parsed = workspaceManifestSchema.safeParse(JSON.parse(raw))
    if (!parsed.success || parsed.data.fingerprint !== fingerprint) return undefined
    return { fingerprint: parsed.data.fingerprint, files: parsed.data.files }
  } catch {
    return undefined
  }
}

export function commandAffectedByChangedPaths(
  check: Extract<GoalVerificationCheck, { kind: "command" }>,
  changedPaths: readonly string[],
): boolean {
  // Git working-tree checks (e.g., git diff --check, git status) inspect all files including docs and are fast.
  if (check.program === "git") return true
  const testPaths = verificationCommandTestPaths(check.program, check.args)
  const candidates = new Set<string>(testPaths)
  for (const arg of check.args) {
    const plain = arg.startsWith("./") && arg.length > 2 ? arg.slice(2) : arg
    candidates.add(arg)
    candidates.add(plain)
  }
  for (const changed of changedPaths) {
    for (const candidate of candidates) {
      if (!candidate) continue
      if (changed === candidate || changed.startsWith(`${candidate}/`) || candidate.startsWith(`${changed}/`)) {
        return true
      }
    }
  }
  return false
}

export function buildVerificationBaseline(
  result: GoalVerificationResult,
  fingerprint: string,
): VerificationBaseline | undefined {
  if (!result.ok) return undefined
  const seen = new Set<string>()
  const checks: CheckEvidence[] = []
  for (const criterion of result.evidence) {
    for (const entry of criterion.checks) {
      if (entry.kind !== "command") continue
      if (!entry.passed || entry.exitCode !== 0 || !entry.outputSha256) return undefined
      if (seen.has(entry.checkSha256)) continue
      seen.add(entry.checkSha256)
      checks.push(entry)
    }
  }
  if (!checks.length) return undefined
  return {
    fingerprint,
    contractSha256: result.contractSha256,
    checkedAt: result.checkedAt,
    checks: checks.slice(0, 40),
  }
}

export async function docOnlyRepairReuse(
  mission: Mission,
  contract: GoalVerificationContract,
): Promise<{ checks: CheckEvidence[]; changedDocPaths: string[]; reuseReason: string } | undefined> {
  const baseline =
    mission.verificationBaseline ??
    (mission.verification?.ok && mission.goalVerification?.ok && mission.verification.fingerprint
      ? buildVerificationBaseline(mission.goalVerification, mission.verification.fingerprint)
      : undefined)
  if (!baseline) return undefined
  const contractSha256 = goalVerificationContractDigest(contract)
  if (baseline.contractSha256 !== contractSha256) return undefined
  if (mission.verificationContractSha256 && mission.verificationContractSha256 !== contractSha256) return undefined
  if (
    !baseline.checks.length ||
    baseline.checks.some(
      (entry) => entry.kind !== "command" || !entry.passed || entry.exitCode !== 0 || !entry.outputSha256,
    )
  ) {
    return undefined
  }
  const prevManifest = await loadVerificationBaselineManifest(mission.workspace.path, baseline.fingerprint)
  if (!prevManifest) return undefined
  let currManifest: WorkspaceManifest
  try {
    currManifest = await workspaceFileManifest(mission.workspace.path)
  } catch {
    return undefined
  }
  const changed = diffWorkspaceManifests(prevManifest, currManifest)
  for (const entry of changed) {
    if (!isDocOnlyPath(entry.path)) return undefined
    if (entry.prev && !entry.prev.regularNonExec) return undefined
    if (entry.curr && !entry.curr.regularNonExec) return undefined
  }
  const changedPaths = changed.map((entry) => entry.path)
  const contractCommands = new Map<string, Extract<GoalVerificationCheck, { kind: "command" }>>()
  for (const criterion of contract.criteria) {
    for (const check of criterion.checks) {
      if (check.kind === "command") contractCommands.set(checkDigest(check), check)
    }
  }
  const reusable = baseline.checks.filter((entry) => {
    const check = contractCommands.get(entry.checkSha256)
    return check !== undefined && !commandAffectedByChangedPaths(check, changedPaths)
  })
  if (!reusable.length) return undefined
  const reuseReason = changedPaths.length
    ? `Explicit command exited zero in the previous passing verification and only documentation files changed since then (${changedPaths.slice(0, 5).join(", ")}${changedPaths.length > 5 ? `, +${changedPaths.length - 5} more` : ""}); its evidence is reused.`
    : "Explicit command exited zero in the previous passing verification on this identical workspace; its evidence is reused."
  return { checks: reusable, changedDocPaths: changedPaths, reuseReason }
}
