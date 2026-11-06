import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
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
  },
): Promise<{ alreadyApplied: boolean; changedPaths: string[] }> {
  await hooks.assertLive?.()
  const patch = await readFile(transaction.patchPath)
  if (createHash("sha256").update(patch).digest("hex") !== transaction.patchSha256)
    throw new Error("Integration patch changed. Restore its saved SHA256 before integration.")
  const current = await captureParallelBaseline(workspace)
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
  const final = await captureParallelBaseline(workspace)
  const applied = await parallelTreeImages(workspace, final.tree)
  const remaining = transaction.changes
    .filter((change) => !same(applied.get(change.path) ?? null, change.after))
    .map((change) => change.path)
  if (remaining.length) throw hooks.conflict(remaining, "Applied task patch did not match its saved post images.")
  await hooks.assertLive?.()
  transaction.status = "applied"
  await hooks.save()
  return { alreadyApplied: false, changedPaths }
}
