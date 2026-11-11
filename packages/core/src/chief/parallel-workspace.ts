import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import { ensureDiskBudget } from "../workspace/disk-budget"
import { integrateContentTransaction } from "./content-transaction"
import {
  type ParallelBaseline,
  type ParallelDelivery,
  ParallelIntegrationConflict,
  type ParallelTaskWorkspace,
  parallelDeliverySchema,
  parallelWorkspaceSchema,
  type TaskChangeSet,
  taskChangeSetSchema,
} from "./parallel-contract"
import { retainTaskEvidence, taskEvidenceRefs } from "./parallel-evidence"
import {
  assertParallelPath,
  captureParallelBaseline,
  parallelBlob,
  parallelGit,
  parallelRoot,
  parallelTreeImages,
  productPaths,
  writeParallelJson,
} from "./parallel-git"
import type { Mission } from "./types"
import { assertMissionWorkspace } from "./workspace"

export * from "./parallel-contract"
export { captureParallelBaseline } from "./parallel-git"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function identity(missionId: string, taskId: string, attempt: number) {
  if (!taskId || taskId.length > 200 || !Number.isSafeInteger(attempt) || attempt < 1)
    throw new Error("Use a valid task ID and positive attempt number for each parallel Actor.")
  return `${hash(missionId).slice(0, 16)}-${hash(taskId).slice(0, 16)}-${attempt}`
}
async function paths(source: string, missionId: string, taskId: string, attempt: number) {
  const root = await parallelRoot(source)
  const key = identity(missionId, taskId, attempt)
  const directory = join(root, "deliveries", key)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const actual = await realpath(directory)
  if (actual !== directory) throw new Error("Parallel delivery storage must stay within the mission.")
  return {
    root,
    directory: actual,
    path: join(root, "workspaces", key),
    record: join(actual, "workspace.json"),
    delivery: join(actual, "delivery.json"),
    patch: join(actual, "changes.patch"),
    branch: `av-task/${key}`,
  }
}
async function validateWorkspace(mission: Mission, workspace: ParallelTaskWorkspace) {
  parallelWorkspaceSchema.parse(workspace)
  if (workspace.missionId !== mission.id) throw new Error("Parallel task workspace belongs to a different mission.")
  const location = await paths(mission.workspace.path, mission.id, workspace.taskId, workspace.attempt)
  if (workspace.sourceWorkspacePath !== (await realpath(mission.workspace.path)))
    throw new Error("Parallel task source workspace does not match this mission.")
  if (workspace.path !== location.path || workspace.branch !== location.branch)
    throw new Error("Restore the recorded private task workspace path and branch before resuming.")
  assertParallelPath(location.root, workspace.path)
  const parent = await realpath(dirname(workspace.path))
  if (!parent.startsWith(`${location.root}${sep}`))
    throw new Error("Parallel workspaces must remain local to the mission.")
  await assertMissionWorkspace({
    ...mission,
    workspace: { ...mission.workspace, path: workspace.path, branch: workspace.branch },
  })
  return location
}

/** Older records stored the snapshot input tree as baselineTree; relabel it without touching any product state. */
async function repairBaselineTreeLabel(
  source: string,
  record: ParallelTaskWorkspace,
): Promise<ParallelTaskWorkspace | undefined> {
  if (record.snapshotTree !== undefined) return undefined
  const committed = (await parallelGit(source, ["rev-parse", `${record.baselineHead}^{tree}`])).trim()
  if (committed === record.baselineTree) return undefined
  if (record.snapshotCommit) {
    const snapshotTree = (await parallelGit(source, ["rev-parse", `${record.snapshotCommit}^{tree}`])).trim()
    if (snapshotTree !== record.baselineTree)
      throw new Error(
        "Parallel baseline tree matches neither its committed baseline nor its recorded snapshot. Preserve the evidence and inspect it before resuming.",
      )
  }
  // Re-parse so the relabeled record keeps the canonical key order used by identity comparisons.
  return parallelWorkspaceSchema.parse({ ...record, snapshotTree: record.baselineTree, baselineTree: committed })
}

/** Every Actor receives the current product snapshot in its own repository, with no shared Git refs or index. */
export async function prepareTaskWorktree(
  mission: Mission,
  taskId: string,
  attempt: number,
  baseline?: ParallelBaseline,
): Promise<ParallelTaskWorkspace> {
  await assertMissionWorkspace(mission)
  const location = await paths(mission.workspace.path, mission.id, taskId, attempt)
  const existing = await readFile(location.record, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    const previous = parallelWorkspaceSchema.parse(JSON.parse(existing))
    await validateWorkspace(mission, previous)
    const record = (await repairBaselineTreeLabel(mission.workspace.path, previous)) ?? previous
    if (record.snapshotCommit) await retainTaskEvidence(record, "snapshot", record.snapshotCommit)
    if (record !== previous) {
      await writeParallelJson(location.record, record)
      const raw = await readFile(location.delivery, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (raw) {
        const delivery = parallelDeliverySchema.parse(JSON.parse(raw))
        // The receipt embeds the workspace identity; keep it equal to the relabeled record.
        if (same(delivery.workspace, previous)) {
          delivery.workspace = record
          await writeParallelJson(location.delivery, delivery)
        }
      }
    }
    return record
  }
  const snapshot = baseline ?? (await captureParallelBaseline(mission.workspace.path))
  await parallelTreeImages(mission.workspace.path, snapshot.tree)
  await mkdir(dirname(location.path), { recursive: true, mode: 0o700 })
  if ((await realpath(dirname(location.path))) !== dirname(location.path))
    throw new Error("Parallel workspaces directory must not redirect through a symlink.")
  if (await lstat(location.path).catch(() => undefined))
    throw new Error(
      `Unrecorded parallel workspace exists at ${location.path}. Preserve its edits and inspect it before retrying.`,
    )
  const referenced = new Set(mission.tasks.flatMap((state) => (state.parallel ? [state.parallel.path] : [])))
  await ensureDiskBudget(dirname(location.path), `a parallel Actor workspace for ${taskId}`, () =>
    releaseAppliedTaskWorktrees(mission, { keep: referenced }),
  )
  await parallelGit(mission.workspace.path, [
    "clone",
    "--local",
    "--no-hardlinks",
    "--no-checkout",
    "--quiet",
    mission.workspace.path,
    location.path,
  ])
  const commit = (
    await parallelGit(
      location.path,
      ["commit-tree", snapshot.tree, "-p", snapshot.head, "-m", `AV task snapshot ${taskId}`],
      {
        GIT_AUTHOR_NAME: "AV task snapshot",
        GIT_AUTHOR_EMAIL: "av-snapshot@example.invalid",
        GIT_COMMITTER_NAME: "AV task snapshot",
        GIT_COMMITTER_EMAIL: "av-snapshot@example.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
    )
  ).trim()
  await parallelGit(location.path, ["checkout", "-q", "-b", location.branch, commit])
  await parallelGit(location.path, ["remote", "remove", "origin"])
  // baselineTree must resolve from baselineHead for reviewers; the snapshot input may add an uncommitted overlay.
  const baselineTree = (await parallelGit(mission.workspace.path, ["rev-parse", `${snapshot.head}^{tree}`])).trim()
  const record: ParallelTaskWorkspace = {
    version: 1,
    missionId: mission.id,
    taskId,
    attempt,
    sourceWorkspacePath: await realpath(mission.workspace.path),
    path: location.path,
    branch: location.branch,
    baselineHead: snapshot.head,
    baselineTree,
    snapshotTree: snapshot.tree,
    snapshotCommit: commit,
    snapshotRef: taskEvidenceRefs({ missionId: mission.id, taskId, attempt }).snapshotRef,
    workerRef: taskEvidenceRefs({ missionId: mission.id, taskId, attempt }).workerRef,
  }
  await retainTaskEvidence(record, "snapshot", commit)
  await writeParallelJson(location.record, record)
  return record
}

/** Save a binary patch plus base/post images before touching the shared mission worktree. */
export async function collectTaskDelivery(
  mission: Mission,
  workspace: ParallelTaskWorkspace,
): Promise<ParallelDelivery> {
  parallelWorkspaceSchema.parse(workspace)
  if (workspace.missionId !== mission.id || workspace.sourceWorkspacePath !== (await realpath(mission.workspace.path)))
    throw new Error("Parallel task workspace belongs to a different mission source.")
  const location = await paths(mission.workspace.path, mission.id, workspace.taskId, workspace.attempt)
  if (workspace.path !== location.path || workspace.branch !== location.branch)
    throw new Error("Restore the recorded private task workspace path and branch before resuming.")
  const existing = await readFile(location.delivery, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (existing) {
    const delivery = parallelDeliverySchema.parse(JSON.parse(existing))
    if (!same(delivery.workspace, workspace)) throw new Error("Saved parallel delivery has a different task identity.")
    await retainDeliveryEvidence(delivery, () => writeParallelJson(location.delivery, delivery))
    return delivery
  }
  await validateWorkspace(mission, workspace)
  const final = await captureParallelBaseline(workspace.path)
  // Legacy records without snapshotTree stored the input tree in baselineTree.
  const inputTree = workspace.snapshotTree ?? workspace.baselineTree
  const [before, after] = await Promise.all([
    parallelTreeImages(workspace.path, inputTree),
    parallelTreeImages(workspace.path, final.tree),
  ])
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const base = before.get(path) ?? null
    const result = after.get(path) ?? null
    return same(base, result) ? [] : [{ path, before: base, after: result }]
  })
  const patch = await parallelGit(workspace.path, [
    "diff",
    "--binary",
    "--no-ext-diff",
    "--no-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    inputTree,
    final.tree,
    ...productPaths,
  ])
  try {
    await writeFile(location.patch, patch, { flag: "wx", mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !same(await readFile(location.patch, "utf8"), patch))
      throw error
  }
  const delivery: ParallelDelivery = {
    version: 1,
    workspace,
    patchPath: location.patch,
    patchSha256: hash(patch),
    deliveryTree: final.tree,
    workerHead: final.head,
    changes,
    status: "prepared",
  }
  await retainDeliveryEvidence(delivery, () => writeParallelJson(location.delivery, delivery))
  await writeParallelJson(location.delivery, delivery)
  return delivery
}

/** Caller merges in plan order after joining workers. A same-file collision always fails. */
export async function integrateTaskDelivery(
  mission: Mission,
  input: ParallelDelivery,
): Promise<{ alreadyApplied: boolean; changedPaths: string[] }> {
  await assertMissionWorkspace(mission)
  parallelDeliverySchema.parse(input)
  const location = await paths(mission.workspace.path, mission.id, input.workspace.taskId, input.workspace.attempt)
  const delivery = parallelDeliverySchema.parse(JSON.parse(await readFile(location.delivery, "utf8")))
  if (
    delivery.workspace.missionId !== mission.id ||
    !same(delivery.workspace, input.workspace) ||
    delivery.patchSha256 !== input.patchSha256 ||
    delivery.patchPath !== location.patch
  )
    throw new Error(
      "Parallel delivery does not match its persisted task identity and patch. Inspect the saved artifacts before recovery.",
    )
  await retainDeliveryEvidence(delivery, () => writeParallelJson(location.delivery, delivery))
  const result = await integrateContentTransaction(mission.workspace.path, delivery, {
    save: () => writeParallelJson(location.delivery, delivery),
    conflict: (paths, detail) => new ParallelIntegrationConflict(delivery.workspace.taskId, paths, detail),
    // The mission index is operator-owned by default. Repositories whose validators compare the index
    // with the worktree can opt in so integrated deliveries are visible to them.
    stage: process.env.AV_STAGE_TASK_DELIVERIES === "1",
  })
  input.status = "applied"
  input.workerHead = delivery.workerHead
  return result
}

async function retainDeliveryEvidence(delivery: ParallelDelivery, save: () => Promise<void>) {
  if (delivery.workspace.snapshotCommit)
    await retainTaskEvidence(delivery.workspace, "snapshot", delivery.workspace.snapshotCommit)
  if (delivery.workerHead) {
    await retainTaskEvidence(delivery.workspace, "worker", delivery.workerHead)
    return
  }
  if (
    delivery.status === "applied" &&
    !delivery.workspace.snapshotCommit &&
    !delivery.workspace.snapshotRef &&
    !delivery.workspace.workerRef
  ) {
    const clone = await lstat(delivery.workspace.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    // Old AV versions disposed completed Actors without retaining revision metadata.
    if (!clone) return
  }
  const current = await captureParallelBaseline(delivery.workspace.path)
  if (current.tree !== delivery.deliveryTree)
    throw new Error("Legacy parallel evidence no longer matches its delivered product tree. Preserve its workspace.")
  await retainTaskEvidence(delivery.workspace, "worker", current.head)
  delivery.workerHead = current.head
  await save()
}

/** No failed or unmerged Actor edits are removed. Patch receipts remain for resume/audit. */
export async function disposeTaskWorktree(workspace: ParallelTaskWorkspace): Promise<boolean> {
  parallelWorkspaceSchema.parse(workspace)
  const location = await paths(workspace.sourceWorkspacePath, workspace.missionId, workspace.taskId, workspace.attempt)
  const raw = await readFile(location.delivery, "utf8").catch(() => undefined)
  if (!raw) return false
  const delivery = parallelDeliverySchema.parse(JSON.parse(raw))
  if (delivery.status !== "applied" || !same(delivery.workspace, workspace)) return false
  const current = await captureParallelBaseline(workspace.sourceWorkspacePath)
  const images = await parallelTreeImages(workspace.sourceWorkspacePath, current.tree)
  if (delivery.changes.some((change) => !same(images.get(change.path) ?? null, change.after))) return false
  assertParallelPath(location.root, workspace.path)
  if (workspace.path !== location.path) throw new Error("Refusing to remove an unrecognized parallel Actor workspace.")
  if (await lstat(workspace.path).catch(() => undefined)) {
    const child = await captureParallelBaseline(workspace.path)
    const [observed, delivered] = await Promise.all([
      parallelTreeImages(workspace.path, child.tree),
      parallelTreeImages(workspace.path, delivery.deliveryTree),
    ])
    if (!same([...observed.entries()], [...delivered.entries()])) return false
  }
  await retainDeliveryEvidence(delivery, () => writeParallelJson(location.delivery, delivery))
  await rm(workspace.path, { recursive: true, force: true })
  return true
}

// Reviews travel as one CLI prompt; opencode/cursor cap argv prompts at 100,000 characters.
const CHANGE_SET_DIFF_LIMIT = 16 * 1024

async function computeTaskChangeSet(
  repository: string,
  workspace: ParallelTaskWorkspace,
  delivery: ParallelDelivery,
): Promise<TaskChangeSet> {
  const inputTree = workspace.snapshotTree ?? workspace.baselineTree
  const details = new Map<string, { size: number; sha256: string }>()
  const files: TaskChangeSet["files"] = []
  for (const change of delivery.changes) {
    const image = change.after ?? change.before
    if (!image) continue
    let detail = details.get(image.oid)
    if (!detail) {
      const content = await parallelBlob(repository, image.oid)
      detail = { size: content.length, sha256: hash(content) }
      details.set(image.oid, detail)
    }
    files.push({
      path: change.path,
      status: change.before === null ? "added" : change.after === null ? "deleted" : "modified",
      size: detail.size,
      sha256: detail.sha256,
    })
  }
  const full = await parallelGit(repository, [
    "diff",
    "--no-ext-diff",
    "--no-renames",
    "--no-color",
    "--unified=3",
    inputTree,
    delivery.deliveryTree,
    ...productPaths,
  ])
  let diff = full
  let diffTruncated = false
  if (Buffer.byteLength(diff, "utf8") > CHANGE_SET_DIFF_LIMIT) {
    diff = `${Buffer.from(diff, "utf8").subarray(0, CHANGE_SET_DIFF_LIMIT).toString("utf8")}\n[AV truncated this unified diff at 16 KB; the file list above remains complete.]`
    diffTruncated = true
  }
  return taskChangeSetSchema.parse({
    version: 1,
    inputTree,
    deliveryTree: delivery.deliveryTree,
    files,
    diff,
    diffTruncated,
  })
}

/**
 * Compute the integrated delta from retained git objects so reviews start from authoritative evidence.
 * The input and delivery trees and their blobs live in the Actor clone while it exists; after disposal
 * only the retained snapshot/worker commits in the mission workspace can answer. The change set is
 * advisory review input, so an unanswerable lookup yields undefined instead of failing integration.
 */
export async function collectTaskChangeSet(
  mission: Mission,
  workspace: ParallelTaskWorkspace,
  delivery: ParallelDelivery,
): Promise<TaskChangeSet | undefined> {
  const clone = await lstat(workspace.path).catch(() => undefined)
  const repositories = clone ? [workspace.path, mission.workspace.path] : [mission.workspace.path]
  for (const repository of repositories) {
    try {
      return await computeTaskChangeSet(repository, workspace, delivery)
    } catch {
      // Try the next repository that may hold the retained objects.
    }
  }
  return undefined
}

/**
 * Remove Actor repositories whose delivery was applied, even when later repairs superseded their edits.
 * Each delivery keeps its patch receipt and retained Git evidence refs. Unapplied or unrecorded Actor
 * repositories, and any path in `keep` (still referenced by an unfinished task), are always retained.
 * With `apply: false` nothing is removed and `released` lists what would be removed.
 */
export async function releaseAppliedTaskWorktrees(
  mission: Mission,
  options: { keep?: ReadonlySet<string>; apply?: boolean } = {},
): Promise<{ released: string[]; retained: string[] }> {
  const source = await realpath(mission.workspace.path)
  if (!(await lstat(join(source, ".agent-valley", "parallel")).catch(() => undefined)))
    return { released: [], retained: [] }
  const root = await parallelRoot(source)
  const workspaces = join(root, "workspaces")
  const names = await readdir(workspaces).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[]
    throw error
  })
  const released: string[] = []
  const retained: string[] = []
  for (const key of names.sort()) {
    const path = join(workspaces, key)
    const receipt = join(root, "deliveries", key, "delivery.json")
    const delivery = await readFile(receipt, "utf8")
      .then((raw) => parallelDeliverySchema.safeParse(JSON.parse(raw)))
      .catch(() => undefined)
    if (
      !delivery?.success ||
      delivery.data.status !== "applied" ||
      delivery.data.workspace.missionId !== mission.id ||
      delivery.data.workspace.path !== path ||
      options.keep?.has(path)
    ) {
      retained.push(path)
      continue
    }
    if (options.apply === false) {
      released.push(path)
      continue
    }
    try {
      assertParallelPath(root, path)
      await retainDeliveryEvidence(delivery.data, () => writeParallelJson(receipt, delivery.data))
      await rm(path, { recursive: true, force: true })
      released.push(path)
    } catch {
      retained.push(path)
    }
  }
  return { released, retained }
}

export async function integrateTaskWorktree(mission: Mission, workspace: ParallelTaskWorkspace) {
  const delivery = await collectTaskDelivery(mission, workspace)
  const result = await integrateTaskDelivery(mission, delivery)
  return { ...result, changeSet: await collectTaskChangeSet(mission, workspace, delivery) }
}
