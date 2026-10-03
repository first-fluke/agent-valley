import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"
import {
  type ParallelBaseline,
  type ParallelDelivery,
  ParallelIntegrationConflict,
  type ParallelTaskWorkspace,
  parallelDeliverySchema,
  parallelWorkspaceSchema,
} from "./parallel-contract"
import {
  assertParallelPath,
  captureParallelBaseline,
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
    const record = parallelWorkspaceSchema.parse(JSON.parse(existing))
    await validateWorkspace(mission, record)
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
  const record: ParallelTaskWorkspace = {
    version: 1,
    missionId: mission.id,
    taskId,
    attempt,
    sourceWorkspacePath: await realpath(mission.workspace.path),
    path: location.path,
    branch: location.branch,
    baselineHead: snapshot.head,
    baselineTree: snapshot.tree,
  }
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
    return delivery
  }
  await validateWorkspace(mission, workspace)
  const final = await captureParallelBaseline(workspace.path)
  const [before, after] = await Promise.all([
    parallelTreeImages(workspace.path, workspace.baselineTree),
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
    workspace.baselineTree,
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
    changes,
    status: "prepared",
  }
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
  const patch = await readFile(location.patch)
  if (hash(patch) !== delivery.patchSha256)
    throw new Error("Parallel delivery patch changed. Restore its saved SHA256 before integration.")
  const current = await captureParallelBaseline(mission.workspace.path)
  const images = await parallelTreeImages(mission.workspace.path, current.tree)
  const differs = (side: "before" | "after") =>
    delivery.changes
      .filter((change) => !same(images.get(change.path) ?? null, change[side]))
      .map((change) => change.path)
  const changedPaths = delivery.changes.map((change) => change.path)
  const before = differs("before")
  const after = differs("after")
  if (delivery.status !== "prepared" && !after.length) {
    delivery.status = "applied"
    await writeParallelJson(location.delivery, delivery)
    input.status = "applied"
    return { alreadyApplied: true, changedPaths }
  }
  if (delivery.status === "applied")
    throw new ParallelIntegrationConflict(delivery.workspace.taskId, after, "Previously integrated task files changed.")
  if (before.length)
    throw new ParallelIntegrationConflict(
      delivery.workspace.taskId,
      before,
      delivery.status === "applying"
        ? "Integration was interrupted or task files changed; inspect its partial delivery."
        : undefined,
    )
  if (patch.length) await parallelGit(mission.workspace.path, ["apply", "--check", "--binary", location.patch])
  delivery.status = "applying"
  await writeParallelJson(location.delivery, delivery)
  if (patch.length)
    await parallelGit(mission.workspace.path, ["apply", "--binary", "--whitespace=nowarn", location.patch])
  const final = await captureParallelBaseline(mission.workspace.path)
  const applied = await parallelTreeImages(mission.workspace.path, final.tree)
  const remaining = delivery.changes
    .filter((change) => !same(applied.get(change.path) ?? null, change.after))
    .map((change) => change.path)
  if (remaining.length)
    throw new ParallelIntegrationConflict(
      delivery.workspace.taskId,
      remaining,
      "Applied task patch did not match its saved post images.",
    )
  delivery.status = "applied"
  await writeParallelJson(location.delivery, delivery)
  input.status = "applied"
  return { alreadyApplied: false, changedPaths }
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
  await rm(workspace.path, { recursive: true, force: true })
  return true
}

export async function integrateTaskWorktree(mission: Mission, workspace: ParallelTaskWorkspace) {
  return integrateTaskDelivery(mission, await collectTaskDelivery(mission, workspace))
}
