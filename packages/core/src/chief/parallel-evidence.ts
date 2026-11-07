import { createHash, randomUUID } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import type { ParallelTaskWorkspace } from "./parallel-contract"
import { parallelGit, parallelRoot } from "./parallel-git"

const objectId = /^[a-f0-9]{40,64}$/
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16)
const git = (root: string, args: string[]) => parallelGit(root, ["--no-replace-objects", ...args])

export function taskEvidenceRefs(workspace: Pick<ParallelTaskWorkspace, "missionId" | "taskId" | "attempt">) {
  const key = `${hash(workspace.missionId)}-${hash(workspace.taskId)}-${workspace.attempt}`
  const prefix = `refs/agent-valley/task-evidence/${key}`
  return { key, snapshotRef: `${prefix}/snapshot`, workerRef: `${prefix}/worker` }
}

async function validateCommit(root: string, workspace: ParallelTaskWorkspace, commit: string, snapshot: boolean) {
  if (!objectId.test(commit)) throw new Error("Parallel evidence requires an exact original commit object ID.")
  const actual = (await git(root, ["rev-parse", "--verify", `${commit}^{commit}`])).trim()
  if (actual !== commit) throw new Error("Parallel evidence commit does not match its original object ID.")
  await git(root, ["merge-base", "--is-ancestor", workspace.baselineHead, commit])
  if (workspace.snapshotTree !== undefined) {
    const committed = (await git(root, ["rev-parse", `${workspace.baselineHead}^{tree}`])).trim()
    if (workspace.baselineTree !== committed)
      throw new Error("Parallel baseline tree does not match the product tree of its committed baseline head.")
  }
  if (snapshot) {
    const parents = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/)
    const tree = (await git(root, ["rev-parse", `${commit}^{tree}`])).trim()
    // Legacy records without snapshotTree stored the snapshot input tree in baselineTree.
    const productTree = workspace.snapshotTree ?? workspace.baselineTree
    if (parents.length !== 2 || parents[1] !== workspace.baselineHead || tree !== productTree)
      throw new Error("Parallel snapshot evidence does not match its recorded parent and product tree.")
  }
}

/** Retain original local objects for review without moving product branches, HEAD or the index. */
export async function retainTaskEvidence(
  workspace: ParallelTaskWorkspace,
  kind: "snapshot" | "worker",
  commit: string,
): Promise<void> {
  const source = await realpath(workspace.sourceWorkspacePath)
  if (source !== workspace.sourceWorkspacePath)
    throw new Error("Parallel evidence source must match its canonical mission workspace.")
  const root = await parallelRoot(source)
  const refs = taskEvidenceRefs(workspace)
  const expectedPath = join(root, "workspaces", refs.key)
  if (
    workspace.path !== expectedPath ||
    workspace.branch !== `av-task/${refs.key}` ||
    (workspace.snapshotRef !== undefined && workspace.snapshotRef !== refs.snapshotRef) ||
    (workspace.workerRef !== undefined && workspace.workerRef !== refs.workerRef)
  )
    throw new Error("Parallel evidence must use its owned task path and private references.")
  const ref = kind === "snapshot" ? refs.snapshotRef : refs.workerRef
  const existing = (await git(source, ["for-each-ref", "--format=%(refname) %(objectname)", ref]))
    .split("\n")
    .find((line) => line.startsWith(`${ref} `))
    ?.slice(ref.length + 1)
  if (existing) {
    if (existing !== commit) throw new Error("Saved parallel evidence reference points to a different original commit.")
    await validateCommit(source, workspace, commit, kind === "snapshot")
    return
  }
  const local = await lstat(expectedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!local) {
    // An already integrated Actor may have been disposed, while its original objects remain local.
    await validateCommit(source, workspace, commit, kind === "snapshot")
    await git(source, ["update-ref", ref, commit, "0".repeat(commit.length)])
    return
  }
  if (!local.isDirectory() || (await realpath(expectedPath)) !== expectedPath)
    throw new Error("Parallel evidence may only be imported from its canonical local Actor repository.")
  const top = (await git(expectedPath, ["rev-parse", "--show-toplevel"])).trim()
  const gitDirectory = (await git(expectedPath, ["rev-parse", "--absolute-git-dir"])).trim()
  if ((await realpath(top)) !== expectedPath || (await realpath(gitDirectory)) !== join(expectedPath, ".git"))
    throw new Error("Parallel evidence Actor repository has a different root.")
  await validateCommit(expectedPath, workspace, commit, kind === "snapshot")
  const temporary = `refs/agent-valley/task-evidence/${refs.key}/imports/${randomUUID()}`
  try {
    await git(source, [
      "-c",
      "protocol.file.allow=always",
      "-c",
      "protocol.ext.allow=never",
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--no-auto-gc",
      "--",
      expectedPath,
      `${commit}:${temporary}`,
    ])
    const fetched = (await git(source, ["rev-parse", "--verify", `${temporary}^{commit}`])).trim()
    if (fetched !== commit) throw new Error("Imported parallel evidence differs from the original Actor commit.")
    await validateCommit(source, workspace, commit, kind === "snapshot")
    await git(source, ["update-ref", ref, commit, "0".repeat(commit.length)])
  } finally {
    await git(source, ["update-ref", "-d", temporary])
  }
}
