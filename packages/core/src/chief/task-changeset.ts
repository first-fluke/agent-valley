import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import {
  type ParallelDelivery,
  type ParallelTaskWorkspace,
  type TaskChangeSet,
  taskChangeSetSchema,
} from "./parallel-contract"
import { captureParallelBaseline, parallelBlob, parallelGit, parallelTreeImages, productPaths } from "./parallel-git"
import type { Mission } from "./types"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// Reviews travel as one CLI prompt; opencode/cursor cap argv prompts at 100,000 characters.
export const CHANGE_SET_DIFF_LIMIT = 16 * 1024

export async function buildTaskChangeSet(
  repository: string,
  inputTree: string,
  deliveryTree: string,
): Promise<TaskChangeSet> {
  const [before, after] = await Promise.all([
    parallelTreeImages(repository, inputTree),
    parallelTreeImages(repository, deliveryTree),
  ])
  const details = new Map<string, { size: number; sha256: string }>()
  const files: TaskChangeSet["files"] = []
  const changes = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const base = before.get(path) ?? null
    const result = after.get(path) ?? null
    return same(base, result) ? [] : [{ path, before: base, after: result }]
  })
  for (const change of changes) {
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
    deliveryTree,
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
    deliveryTree,
    files,
    diff,
    diffTruncated,
  })
}

async function computeTaskChangeSet(
  repository: string,
  workspace: ParallelTaskWorkspace,
  delivery: ParallelDelivery,
): Promise<TaskChangeSet> {
  const inputTree = workspace.snapshotTree ?? workspace.baselineTree
  return buildTaskChangeSet(repository, inputTree, delivery.deliveryTree)
}

/**
 * Capture the git tree SHA of a workspace using a safe temporary index.
 * Fails closed by returning undefined if the workspace is not a git repository or capture fails.
 */
export async function captureWorkspaceTree(workspacePath: string): Promise<string | undefined> {
  try {
    const baseline = await captureParallelBaseline(workspacePath)
    return baseline.tree
  } catch {
    return undefined
  }
}

/**
 * Build a standard TaskChangeSet for a direct-in-workspace task between `inputTree` and `deliveryTree`.
 * When `deliveryTree` is omitted, captures the current workspace tree.
 * Fails closed by returning undefined on error.
 */
export async function collectDirectChangeSet(
  workspacePath: string,
  inputTree: string,
  deliveryTree?: string,
): Promise<TaskChangeSet | undefined> {
  try {
    const targetTree = deliveryTree ?? (await captureParallelBaseline(workspacePath)).tree
    return await buildTaskChangeSet(workspacePath, inputTree, targetTree)
  } catch {
    return undefined
  }
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
