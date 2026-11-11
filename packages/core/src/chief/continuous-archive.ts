import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { readContinuousMissionWorkspace } from "./continuous-workspace"
import { captureParallelBaseline, parallelGit, writeParallelJson } from "./parallel-git"

const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const archiveSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().min(1),
  missionId: z.string().min(1),
  branch: z.string().min(1),
  baselineCommit: sha,
  headCommit: sha,
  productCommit: sha,
  repository: z.string().min(1),
  refPrefix: z.string().min(1),
  receipts: z.array(z.string()),
  archivedAt: z.iso.datetime(),
  restore: z.string(),
})
export type ContinuousChildArchive = z.infer<typeof archiveSchema>

const snapshotIdentity = {
  GIT_AUTHOR_NAME: "AV operation archive",
  GIT_AUTHOR_EMAIL: "av-archive@example.invalid",
  GIT_COMMITTER_NAME: "AV operation archive",
  GIT_COMMITTER_EMAIL: "av-archive@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
}
const exists = (path: string) =>
  lstat(path).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false
      throw error
    },
  )

/** One bare repository per operation stores every archived child; shared history is stored once. */
export function operationArchiveRepository(container: string): string {
  return join(dirname(dirname(container)), "archive.git")
}

export async function readContinuousChildArchive(container: string): Promise<ContinuousChildArchive | undefined> {
  const raw = await readFile(join(container, "archive", "archive.json"), "utf8").catch(() => undefined)
  return raw === undefined ? undefined : archiveSchema.parse(JSON.parse(raw))
}

/**
 * Replace a finished operation child workspace with durable, much smaller evidence:
 * its branches, AV evidence refs and an exact product commit (including uncommitted files) move to the
 * operation's `archive.git`, and its AV receipts move to `<container>/archive/`. Only ignored build output
 * and the duplicated clone are dropped. With `apply: false` nothing changes.
 */
export async function archiveContinuousChild(
  container: string,
  options: { apply?: boolean; now?: () => Date } = {},
): Promise<{ status: "archived" | "eligible" | "already-archived"; repository: string }> {
  const record = await readContinuousMissionWorkspace(container)
  if (!record)
    throw new Error(
      `${container} has no matching AV operation child receipt (workspace.json). Preserve it and inspect it manually.`,
    )
  const repository = operationArchiveRepository(container)
  const archiveDirectory = join(container, "archive")
  const existing = await readContinuousChildArchive(container)
  if (existing) {
    if (options.apply !== false) await rm(record.path, { recursive: true, force: true })
    return { status: "already-archived", repository }
  }
  if (!(await exists(record.path)))
    throw new Error(
      `Operation child ${record.missionId} workspace is missing and has no archive receipt. Preserve ${container} and restore the workspace before archiving.`,
    )
  const branch = (await parallelGit(record.path, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()
  if (branch !== record.branch)
    throw new Error(
      `Operation child ${record.missionId} is on ${branch}, not its recorded branch ${record.branch}. Restore the branch before archiving.`,
    )
  if (options.apply === false) return { status: "eligible", repository }

  const snapshot = await captureParallelBaseline(record.path)
  const productCommit = (
    await parallelGit(
      record.path,
      ["commit-tree", snapshot.tree, "-p", snapshot.head, "-m", `AV archived operation child ${record.missionId}`],
      snapshotIdentity,
    )
  ).trim()
  await parallelGit(record.path, ["update-ref", "refs/agent-valley/archive/product", productCommit])
  if (!(await exists(repository))) await parallelGit(dirname(repository), ["init", "--bare", "--quiet", repository])
  const refPrefix = `refs/missions/${record.missionId}`
  await parallelGit(repository, [
    "-c",
    "protocol.file.allow=always",
    "fetch",
    "--no-tags",
    "--quiet",
    record.path,
    `+refs/heads/*:${refPrefix}/heads/*`,
    `+refs/agent-valley/*:${refPrefix}/agent-valley/*`,
  ])
  const stored = (
    await parallelGit(repository, ["rev-parse", "--verify", `${refPrefix}/agent-valley/archive/product`])
  ).trim()
  if (stored !== productCommit)
    throw new Error(`Archive repository ${repository} did not store the product commit. Preserve the child workspace.`)
  const missing = await parallelGit(repository, ["rev-list", "--objects", "--missing=print", productCommit])
  if (missing.split("\n").some((line) => line.startsWith("?")))
    throw new Error(
      `Archive repository ${repository} is missing objects for ${productCommit}. Preserve the child workspace.`,
    )

  await mkdir(archiveDirectory, { recursive: true, mode: 0o700 })
  const receipts: string[] = []
  for (const name of [".agent-valley", ".agents"]) {
    const source = join(record.path, name)
    if (!(await exists(source))) continue
    let target = join(archiveDirectory, name.slice(1))
    if (await exists(target)) target = `${target}-${Date.now()}`
    await rename(source, target)
    receipts.push(target)
  }
  const archive: ContinuousChildArchive = {
    version: 1,
    operationId: record.operationId,
    missionId: record.missionId,
    branch: record.branch,
    baselineCommit: record.baselineCommit,
    headCommit: snapshot.head,
    productCommit,
    repository,
    refPrefix,
    receipts,
    archivedAt: (options.now ?? (() => new Date()))().toISOString(),
    restore: `git clone ${repository} <dir> && git -C <dir> checkout ${productCommit}`,
  }
  await writeParallelJson(join(archiveDirectory, "archive.json"), archive)
  await rm(record.path, { recursive: true, force: true })
  return { status: "archived", repository }
}
