import { lstat, mkdir, readFile, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import type { Workspace } from "../domain/models"
import { type ContinuousBaseline, continuousBaselineSchema, operationIdSchema } from "./continuous-contract"
import { fingerprintWorkspace } from "./fingerprint"
import { captureParallelBaseline, parallelGit, parallelTreeImages, writeParallelJson } from "./parallel-git"

async function localDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  if ((await realpath(path)) !== resolve(path))
    throw new Error("Continuous operation storage redirects through a symlink. Restore its original private directory.")
}

async function operationDirectory(repositoryRoot: string, operationId: string): Promise<string> {
  operationIdSchema.parse(operationId)
  const root = await realpath(repositoryRoot)
  const top = (await parallelGit(root, ["rev-parse", "--show-toplevel"])).trim()
  if (root !== resolve(repositoryRoot) || (await realpath(top)) !== root)
    throw new Error("Use the operation's original canonical Git repository root before resuming.")
  const directory = join(root, ".agent-valley", "operations", operationId)
  await localDirectory(directory)
  return directory
}

async function readJson(path: string): Promise<unknown | undefined> {
  const stats = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!stats) return undefined
  if (!stats.isFile()) throw new Error("Operation receipts must be regular local files. Restore the original receipt.")
  return JSON.parse(await readFile(path, "utf8"))
}

async function assertRepository(path: string, branch: string, commit?: string): Promise<void> {
  if ((await realpath(path)) !== path || !(await lstat(join(path, ".git"))).isDirectory())
    throw new Error("Operation workspace must remain an independent local Git repository.")
  const [top, currentBranch, head] = await Promise.all([
    parallelGit(path, ["rev-parse", "--show-toplevel"]),
    parallelGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    parallelGit(path, ["rev-parse", "HEAD"]),
  ])
  if ((await realpath(top.trim())) !== path || currentBranch.trim() !== branch || (commit && head.trim() !== commit))
    throw new Error(
      "Operation workspace identity or snapshot HEAD changed. Restore its recorded Git metadata before resuming.",
    )
}

/** Frozen product trees are independent repositories; original refs and index remain untouched. */
export async function prepareContinuousBaseline(
  repositoryRoot: string,
  operationId: string,
  sourceWorkspacePath: string,
  missionId?: string,
  expectedFingerprint?: string,
): Promise<ContinuousBaseline> {
  if (missionId) operationIdSchema.parse(missionId)
  if (expectedFingerprint !== undefined && !/^[a-f0-9]{64}$/.test(expectedFingerprint))
    throw new Error("Use the completed child's original SHA256 verification fingerprint when accepting a snapshot.")
  const directory = join(await operationDirectory(repositoryRoot, operationId), "baselines", missionId ?? "initial")
  await localDirectory(directory)
  const recordPath = join(directory, "baseline.json")
  const preparedPath = join(directory, "snapshot.json")
  const path = join(directory, "workspace")
  const source = await realpath(sourceWorkspacePath)
  const existing = await readJson(recordPath)
  if (existing) {
    const receipt = continuousBaselineSchema.parse(existing)
    if (
      receipt.sourceWorkspacePath !== source ||
      receipt.missionId !== missionId ||
      receipt.verifiedFingerprint !== expectedFingerprint
    )
      throw new Error(
        "Accepted snapshot source or child identity changed. Restore the original receipt before continuing.",
      )
    return validateContinuousBaseline(repositoryRoot, operationId, path)
  }
  let snapshot: ContinuousBaseline
  const prepared = await readJson(preparedPath)
  if (prepared) {
    snapshot = continuousBaselineSchema.parse(prepared)
    if (
      snapshot.operationId !== operationId ||
      snapshot.repositoryRoot !== repositoryRoot ||
      snapshot.sourceWorkspacePath !== source ||
      snapshot.missionId !== missionId ||
      snapshot.verifiedFingerprint !== expectedFingerprint ||
      snapshot.path !== path
    )
      throw new Error("Prepared snapshot identity changed. Restore its original transaction receipt.")
  } else {
    if (expectedFingerprint && (await fingerprintWorkspace(source)) !== expectedFingerprint)
      throw new Error(
        "Completed child product files changed after verification. Preserve its edits and reconcile its original verified mission before accepting a snapshot.",
      )
    const baseline = await captureParallelBaseline(source)
    if (expectedFingerprint && (await fingerprintWorkspace(source)) !== expectedFingerprint)
      throw new Error(
        "Completed child changed during snapshot capture. Preserve its edits and restore its verified workspace before continuing.",
      )
    await parallelTreeImages(source, baseline.tree)
    const branch = `av-operation/${operationId}/baseline-${missionId ?? "initial"}`
    const commit = (
      await parallelGit(
        source,
        [
          "commit-tree",
          baseline.tree,
          "-p",
          baseline.head,
          "-m",
          `AV operation ${operationId} snapshot ${missionId ?? "initial"}`,
        ],
        {
          GIT_AUTHOR_NAME: "AV operation snapshot",
          GIT_AUTHOR_EMAIL: "av-snapshot@example.invalid",
          GIT_COMMITTER_NAME: "AV operation snapshot",
          GIT_COMMITTER_EMAIL: "av-snapshot@example.invalid",
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        },
      )
    ).trim()
    snapshot = {
      version: 1,
      operationId,
      repositoryRoot,
      sourceWorkspacePath: source,
      missionId,
      path,
      branch,
      baselineHead: baseline.head,
      baselineTree: baseline.tree,
      commit,
      verifiedFingerprint: expectedFingerprint,
    }
    await writeParallelJson(preparedPath, snapshot)
  }
  await ensureClone(snapshot.sourceWorkspacePath, snapshot.path, snapshot.branch, snapshot.commit)
  await writeParallelJson(recordPath, snapshot)
  return validateContinuousBaseline(repositoryRoot, operationId, snapshot.path)
}

async function ensureClone(source: string, path: string, branch: string, commit: string): Promise<void> {
  const exists = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!exists) {
    await parallelGit(source, ["clone", "--local", "--no-hardlinks", "--no-checkout", "--quiet", source, path])
  } else if (!exists.isDirectory() || (await realpath(path)) !== path) {
    throw new Error("Operation workspace path redirects outside its private directory. Restore it before resuming.")
  }
  if (!(await lstat(join(path, ".git"))).isDirectory() || (await realpath(join(path, ".git"))) !== join(path, ".git"))
    throw new Error("Operation clone Git metadata must remain within its independent private repository.")
  const currentBranch = (await parallelGit(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()
  if (currentBranch !== branch) {
    // A saved snapshot transaction owns only a never-checked-out clone. Any populated index is preserved for inspection.
    const index = await lstat(join(path, ".git", "index")).catch(() => undefined)
    if (index)
      throw new Error(
        "Interrupted operation clone has an unexpected index. Preserve it and restore the recorded snapshot before resuming.",
      )
    await parallelGit(path, ["checkout", "-q", "-b", branch, commit])
  }
  const remotes = (await parallelGit(path, ["remote"])).trim().split("\n")
  if (remotes.includes("origin")) await parallelGit(path, ["remote", "remove", "origin"])
  await assertRepository(path, branch, commit)
}

export async function validateContinuousBaseline(
  repositoryRoot: string,
  operationId: string,
  baselinePath: string,
): Promise<ContinuousBaseline> {
  const root = await operationDirectory(repositoryRoot, operationId)
  const path = resolve(baselinePath)
  const key = dirname(path).split(/[\\/]/).at(-1) ?? ""
  operationIdSchema.parse(key)
  if (path !== join(root, "baselines", key, "workspace") || (await realpath(dirname(path))) !== dirname(path))
    throw new Error("Accepted baseline path is outside this operation's private snapshot directory.")
  const snapshot = continuousBaselineSchema.parse(await readJson(join(dirname(path), "baseline.json")))
  const expected = join(root, "baselines", snapshot.missionId ?? "initial", "workspace")
  if (
    snapshot.operationId !== operationId ||
    snapshot.repositoryRoot !== repositoryRoot ||
    snapshot.path !== path ||
    path !== expected ||
    (await realpath(dirname(path))) !== dirname(path)
  )
    throw new Error(
      "Accepted baseline does not belong to this operation or repository. Restore its original local receipt.",
    )
  await assertRepository(path, snapshot.branch, snapshot.commit)
  const current = await captureParallelBaseline(path)
  if (current.tree !== snapshot.baselineTree)
    throw new Error(
      "Accepted baseline product files changed. Preserve those edits and restore the frozen baseline before continuing.",
    )
  return snapshot
}

const missionWorkspaceSchema = z.strictObject({
  operationId: operationIdSchema,
  repositoryRoot: z.string().min(1),
  missionId: operationIdSchema,
  baselinePath: z.string().min(1),
  baselineCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  path: z.string().min(1),
  branch: z.string().min(1),
  createdAt: z.iso.datetime(),
})

/** Child and decision repositories are siblings of frozen baselines, so new work cannot alter accepted trees. */
export async function createContinuousMissionWorkspace(
  repositoryRoot: string,
  operationId: string,
  baselinePath: string,
  missionId: string,
  _goal: string,
): Promise<Workspace> {
  operationIdSchema.parse(missionId)
  const baseline = await validateContinuousBaseline(repositoryRoot, operationId, baselinePath)
  const root = await operationDirectory(repositoryRoot, operationId)
  const directory = join(root, "workspaces", missionId)
  await localDirectory(directory)
  const path = join(directory, "workspace")
  const branch = `av-operation/${operationId}/${missionId}`
  const recordPath = join(directory, "workspace.json")
  const raw = await readJson(recordPath)
  const record = raw
    ? missionWorkspaceSchema.parse(raw)
    : {
        operationId,
        repositoryRoot,
        missionId,
        baselinePath: baseline.path,
        baselineCommit: baseline.commit,
        path,
        branch,
        createdAt: new Date().toISOString(),
      }
  if (
    record.operationId !== operationId ||
    record.repositoryRoot !== repositoryRoot ||
    record.missionId !== missionId ||
    record.baselinePath !== baseline.path ||
    record.baselineCommit !== baseline.commit ||
    record.path !== path ||
    record.branch !== branch
  )
    throw new Error(
      "Child workspace identity does not match this operation's saved baseline. Restore its original receipt.",
    )
  if (!raw) {
    const preparedPath = join(directory, "prepared.json")
    const prepared = await readJson(preparedPath)
    if (prepared && JSON.stringify(missionWorkspaceSchema.parse(prepared)) !== JSON.stringify(record)) {
      const saved = missionWorkspaceSchema.parse(prepared)
      if (
        saved.operationId !== record.operationId ||
        saved.repositoryRoot !== record.repositoryRoot ||
        saved.missionId !== record.missionId ||
        saved.baselinePath !== record.baselinePath ||
        saved.baselineCommit !== record.baselineCommit ||
        saved.path !== record.path ||
        saved.branch !== record.branch
      )
        throw new Error("Prepared child workspace identity changed. Restore its original receipt.")
      record.createdAt = saved.createdAt
    }
    if (!prepared) await writeParallelJson(preparedPath, record)
    await ensureClone(baseline.path, path, branch, baseline.commit)
    await writeParallelJson(recordPath, record)
  } else await assertRepository(path, branch)
  return {
    issueId: missionId,
    key: `ORDER-${missionId.slice(0, 8)}`,
    path,
    branch,
    status: "idle",
    createdAt: record.createdAt,
  }
}
