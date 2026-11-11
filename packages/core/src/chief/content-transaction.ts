import { createHash, randomUUID } from "node:crypto"
import { lstat, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParallelDelivery } from "./parallel-contract"
import { captureParallelBaseline, parallelGit, parallelTreeImages } from "./parallel-git"

type ContentTransaction = Pick<ParallelDelivery, "patchPath" | "patchSha256" | "changes" | "status">

/** Apply only proven before-images; retain ambiguous partial transactions for inspection. */
export async function integrateContentTransaction(
  workspace: string,
  transaction: ContentTransaction,
  hooks: {
    save(): Promise<void>
    conflict(paths: string[], detail?: string): Error
    assertLive?(): Promise<void>
    /**
     * Stage delivered paths in the target index after apply. Task deliveries into the mission workspace
     * opt in so repository validators see them; operation source integration must leave the operator's
     * index untouched and keeps the default.
     */
    stage?: boolean
  },
): Promise<{ alreadyApplied: boolean; changedPaths: string[] }> {
  await hooks.assertLive?.()
  const patch = await readFile(transaction.patchPath)
  if (createHash("sha256").update(patch).digest("hex") !== transaction.patchSha256)
    throw new Error("Integration patch changed. Restore its saved SHA256 before integration.")
  // Delivered paths stay visible to the before/after comparison even where the target ignores them.
  const include = transaction.changes.map((change) => change.path)
  const current = await captureParallelBaseline(workspace, { include })
  const images = await parallelTreeImages(workspace, current.tree)
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const differs = (side: "before" | "after") =>
    transaction.changes
      .filter((change) => !same(images.get(change.path) ?? null, change[side]))
      .map((change) => change.path)
  const changedPaths = transaction.changes.map((change) => change.path)
  const before = differs("before")
  const after = differs("after")
  if (transaction.status !== "prepared" && !after.length) {
    transaction.status = "applied"
    await hooks.assertLive?.()
    await hooks.save()
    return { alreadyApplied: true, changedPaths }
  }
  if (transaction.status === "applied") throw hooks.conflict(after, "Previously integrated task files changed.")
  if (before.length)
    throw hooks.conflict(
      before,
      transaction.status === "applying"
        ? "Integration was interrupted or task files changed; inspect its partial delivery."
        : undefined,
    )
  await hooks.assertLive?.()
  if (patch.length) await parallelGit(workspace, ["apply", "--check", "--binary", transaction.patchPath])
  transaction.status = "applying"
  await hooks.save()
  await hooks.assertLive?.()
  if (patch.length) await parallelGit(workspace, ["apply", "--binary", "--whitespace=nowarn", transaction.patchPath])
  const final = await captureParallelBaseline(workspace, { include })
  const applied = await parallelTreeImages(workspace, final.tree)
  const remaining = transaction.changes
    .filter((change) => !same(applied.get(change.path) ?? null, change.after))
    .map((change) => change.path)
  if (remaining.length) throw hooks.conflict(remaining, "Applied task patch did not match its saved post images.")
  await hooks.assertLive?.()
  if (hooks.stage) await stageIntegratedPaths(workspace, changedPaths)
  transaction.status = "applied"
  await hooks.save()
  return { alreadyApplied: false, changedPaths }
}

/**
 * `git apply` only touches the worktree, so integrated deliveries used to sit unstaged: new files stayed
 * untracked and staged files showed as modified, which breaks repository validators that compare the
 * index with the worktree (`git ls-files`, "indexed and working evidence differ"). Stage the delivered
 * paths in the mission index, except files the mission intentionally untracked (`git rm --cached`).
 */
export async function stageIntegratedPaths(workspace: string, paths: string[]): Promise<void> {
  if (!paths.length) return
  const head = (await parallelGit(workspace, ["rev-parse", "HEAD"])).trim()
  const tracked = new Set((await parallelGit(workspace, ["ls-tree", "-r", "--name-only", "-z", head])).split("\0"))
  const cached = new Set((await parallelGit(workspace, ["ls-files", "--cached", "-z"])).split("\0"))
  // A delivery can delete a file that was never indexed (created unstaged by an earlier in-workspace
  // Actor). Nothing is left to stage for it, and naming it makes `git add` fail on the whole pathspec.
  const present = async (path: string) =>
    lstat(join(workspace, path)).then(
      () => true,
      () => false,
    )
  const stageable: string[] = []
  for (const path of new Set(paths)) {
    if (!path) continue
    if (cached.has(path) || (!tracked.has(path) && (await present(path)))) stageable.push(path)
  }
  if (!stageable.length) return
  const pathsFile = join(tmpdir(), `av-stage-${randomUUID()}.paths`)
  await writeFile(pathsFile, `${stageable.join("\0")}\0`, { flag: "wx", mode: 0o600 })
  try {
    await parallelGit(workspace, ["add", "-A", "-f", `--pathspec-from-file=${pathsFile}`, "--pathspec-file-nul"], {
      GIT_LITERAL_PATHSPECS: "1",
    })
  } finally {
    await rm(pathsFile, { force: true })
  }
}
