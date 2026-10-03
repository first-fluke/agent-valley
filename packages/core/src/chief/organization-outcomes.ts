import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"
import { z } from "zod"
import { runCommand } from "../workspace/worktree-lifecycle"
import { fingerprintWorkspace } from "./fingerprint"
import type { operatingRunSchema, RouteEvidence } from "./operations"
import { appendOrganizationRecord, organizationRecordKey, readOrganizationRecords } from "./organization-store"
import {
  type MemoryEvidence,
  memoryEvidenceSchema,
  type OrganizationOutcome,
  organizationOutcomeSchema,
} from "./organization-types"
import type { Mission } from "./types"

const evidenceInputSchema = memoryEvidenceSchema.partial({ sha256: true })
const inputSchema = organizationOutcomeSchema
  .omit({ id: true, createdAt: true, summaryAuthority: true, evidence: true, observations: true })
  .extend({
    workspacePath: z.string().min(1).max(2_000),
    evidence: evidenceInputSchema.array().max(30),
    observations: z
      .array(
        z.strictObject({
          content: z.string().trim().min(1).max(1_000),
          evidence: memoryEvidenceSchema.array().min(1).max(30),
        }),
      )
      .max(20)
      .default([]),
  })
async function verifyArtifact(root: string, input: z.infer<typeof evidenceInputSchema>): Promise<MemoryEvidence> {
  const path = resolve(root, input.path)
  const actual = await realpath(path)
  const local = relative(root, actual)
  if (!local || local.startsWith(`..${sep}`) || local === ".." || resolve(root, local) !== actual)
    throw new Error(
      "Organization artifact evidence escapes the mission worktree. Use an actual delivered file within it.",
    )
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > 32_000_000)
      throw new Error("Organization artifact evidence must be a regular file of at most 32 MB.")
    const hash = createHash("sha256")
    for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk as Buffer)
    const sha256 = hash.digest("hex")
    if (input.sha256 && input.sha256 !== sha256)
      throw new Error("Organization artifact evidence changed. Refresh its verified digest before saving memory.")
    return { path: local, sha256, verification: input.verification }
  } finally {
    await file.close()
  }
}
export async function listOrganizationOutcomes(sourceRepo: string): Promise<OrganizationOutcome[]> {
  return (await readOrganizationRecords(sourceRepo, "outcomes", organizationOutcomeSchema)).sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )
}
export async function recordOrganizationOutcome(sourceRepo: string, input: unknown): Promise<OrganizationOutcome> {
  const parsed = inputSchema.parse(input)
  if (new Set(parsed.runs.map((run) => run.runId)).size !== parsed.runs.length)
    throw new Error("Finalized operating run IDs must be unique.")
  const root = await realpath(parsed.workspacePath)
  if (root === (await realpath(sourceRepo)))
    throw new Error(
      "Finalize organization memory from the isolated mission worktree, outside the source-repository store.",
    )
  const actualFingerprint = await fingerprintWorkspace(root)
  if (actualFingerprint !== parsed.fingerprint)
    throw new Error(
      "Mission workspace changed since verification. Verify the current files before saving organization memory.",
    )
  if (
    parsed.status === "completed" &&
    (!parsed.verification?.ok || parsed.verification.fingerprint !== actualFingerprint || !parsed.finalReviewPassed)
  )
    throw new Error(
      "Completed organization outcomes require matching successful verification and final review evidence.",
    )
  const evidence = await Promise.all(parsed.evidence.map((item) => verifyArtifact(root, item)))
  const observations = parsed.observations.map((observation) => {
    for (const item of observation.evidence)
      if (!evidence.some((actual) => actual.path === item.path && actual.sha256 === item.sha256))
        throw new Error(
          "Organization observations must link to the finalized delivered evidence. Approve standards explicitly with av memory add.",
        )
    return { ...observation, authority: "evidence-linked observation; not an approved standard" as const }
  })
  if (evidence.length && !observations.length)
    observations.push({
      content: `Mission ${parsed.status}; fixed verification ${parsed.verification?.ok ? "passed" : "not passed"}; final review ${parsed.finalReviewPassed ? "passed" : "not passed"}.`,
      evidence,
      authority: "evidence-linked observation; not an approved standard",
    })
  if ((await fingerprintWorkspace(root)) !== actualFingerprint)
    throw new Error("Workspace changed while collecting organization evidence. Verify again.")
  const { workspacePath: _workspacePath, ...data } = parsed
  const identity = [parsed.missionId, parsed.missionVersion, parsed.fingerprint]
  const outcome = organizationOutcomeSchema.parse({
    ...data,
    id: organizationRecordKey(identity),
    evidence,
    observations,
    createdAt: new Date().toISOString(),
    summaryAuthority: "reported claim; evidence is authoritative",
  })
  return appendOrganizationRecord(sourceRepo, "outcomes", identity, outcome, organizationOutcomeSchema, true)
}
async function deliveredArtifacts(workspace: string): Promise<{ path: string }[]> {
  const [changed, untracked] = await Promise.all([
    runCommand("git", ["diff", "--name-only", "--diff-filter=AM", "-z", "HEAD"], { cwd: workspace }),
    runCommand("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace }),
  ])
  if (changed.exitCode !== 0 || untracked.exitCode !== 0)
    throw new Error("Cannot collect delivered files for organization memory. Restore the worktree Git metadata.")
  const paths = [...new Set(`${changed.stdout}\0${untracked.stdout}`.split("\0").filter(Boolean))]
    .filter((path) => !/^(?:\.agent-valley|\.agents|\.claude|\.codex|\.cursor)\//.test(path))
    .sort()
  const evidence: { path: string }[] = []
  for (const path of paths) {
    if (evidence.length >= 30) break
    const stat = await lstat(resolve(workspace, path))
    if (stat.isFile() && stat.size <= 32_000_000) evidence.push({ path })
  }
  return evidence
}
/** Framework facts are recorded; actor prose never becomes an approved decision or stack standard. */
export async function recordMissionOrganizationOutcome(
  sourceRepo: string,
  mission: Mission,
): Promise<OrganizationOutcome> {
  if (!["completed", "failed"].includes(mission.status))
    throw new Error("Only terminal missions can be added to organization history.")
  const fingerprint = await fingerprintWorkspace(mission.workspace.path)
  const missionVersion = organizationRecordKey([
    mission.goal,
    mission.goalBrief,
    mission.plan,
    mission.personas,
    mission.verifyCommand,
    mission.status,
    mission.verification?.ok,
    mission.finalReview?.criteria,
  ])
  return recordOrganizationOutcome(sourceRepo, {
    missionId: mission.id,
    missionVersion,
    fingerprint,
    workspacePath: mission.workspace.path,
    goal: mission.goal.slice(0, 16_000),
    status: mission.status,
    summary: (mission.report?.summary ?? mission.error ?? `Mission ${mission.status}`).slice(0, 2_000),
    evidence: await deliveredArtifacts(mission.workspace.path),
    observations: [],
    runs: mission.operations?.runs ?? [],
    verification: mission.verification
      ? {
          ok: mission.verification.ok,
          fingerprint: mission.verification.fingerprint,
          command:
            (mission.supervision?.operatorVerifyCommand ?? mission.verifyCommand) ||
            (mission.verificationContractSha256
              ? `Chief verification contract ${mission.verificationContractSha256}`
              : undefined),
        }
      : undefined,
    finalReviewPassed: !!mission.finalReview?.passed && mission.finalReview.findings.length === 0,
  })
}
export async function getOrganizationRouteEvidence(sourceRepo: string): Promise<RouteEvidence[]> {
  const outcomes = await listOrganizationOutcomes(sourceRepo)
  const runs = new Map<string, z.infer<typeof operatingRunSchema>>()
  for (const outcome of outcomes)
    for (const run of outcome.runs) {
      if (run.stage !== "work" || !run.taskId || run.outcome === "pending") continue
      const id = `${outcome.missionId}:${run.runId}`
      if (!runs.has(id)) runs.set(id, run)
    }
  const groups = new Map<string, RouteEvidence>()
  for (const run of runs.values()) {
    const model = run.model
    const key = JSON.stringify([run.actorType, model])
    const group = groups.get(key) ?? {
      actorType: run.actorType,
      model,
      samples: 0,
      successes: 0,
      totalCostUsd: 0,
      successfulDeliverableCostUsd: null,
    }
    group.samples++
    if (run.outcome === "passed") group.successes++
    group.totalCostUsd = group.totalCostUsd === null || run.costUsd === null ? null : group.totalCostUsd + run.costUsd
    group.successfulDeliverableCostUsd =
      group.successes > 0 && group.totalCostUsd !== null ? group.totalCostUsd / group.successes : null
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) =>
    JSON.stringify([a.actorType, a.model]).localeCompare(JSON.stringify([b.actorType, b.model])),
  )
}
