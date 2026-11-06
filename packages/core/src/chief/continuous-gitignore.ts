import { randomUUID } from "node:crypto"
import { lstat, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { appendRuntimeGitignoreRule, prepareRuntimeGitignore } from "../workspace/runtime-ignore"
import { type ParallelDelivery, parallelDeliverySchema } from "./parallel-contract"
import { parallelGit } from "./parallel-git"

type Change = ParallelDelivery["changes"][number]
type Image = NonNullable<Change["before"]>
const imageSchema = parallelDeliverySchema.shape.changes.element.shape.before
export const gitignoreProjectionSchema = z.strictObject({
  path: z.literal(".gitignore"),
  verifiedBefore: imageSchema,
  verifiedAfter: imageSchema,
  sourceBefore: imageSchema.unwrap(),
  sourceAfter: imageSchema.unwrap(),
})
type Projection = z.infer<typeof gitignoreProjectionSchema>

async function artifact(path: string, value: string): Promise<void> {
  try {
    await writeFile(path, value, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || !(await readFile(path)).equals(Buffer.from(value)))
      throw new Error(
        "Projected runtime-ignore bytes changed. Restore the original source integration artifacts before retrying.",
      )
  }
}

async function projectedPatch(workspace: string, directory: string, before: Image, after: Image): Promise<string> {
  const index = join(directory, `gitignore-index-${randomUUID()}`)
  const env = { GIT_INDEX_FILE: index }
  try {
    await parallelGit(workspace, ["read-tree", "--empty"], env)
    const tree = async (image: Image) => {
      await parallelGit(
        workspace,
        ["update-index", "--add", "--cacheinfo", `${image.mode},${image.oid},.gitignore`],
        env,
      )
      return (await parallelGit(workspace, ["write-tree"], env)).trim()
    }
    const first = await tree(before)
    const second = await tree(after)
    return parallelGit(workspace, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      first,
      second,
      "--",
      ".gitignore",
    ])
  } finally {
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
  }
}

/** Preserve only AV's exact canonical append; arbitrary ignore-file edits are never merged. */
export async function projectContinuousGitignore(
  workspace: string,
  sourceWorkspace: string,
  directory: string,
  verified: Change | undefined,
  observed: Image | undefined,
  saved?: Projection,
): Promise<{ projection: Projection; change: Change; patch: string } | undefined> {
  if (!verified) {
    if (saved)
      throw new Error(
        "A saved runtime-ignore projection has no verified .gitignore change. Restore the original receipt.",
      )
    return undefined
  }
  const read = async (image: Image | null) => (image ? parallelGit(workspace, ["cat-file", "blob", image.oid]) : "")
  const before = await read(verified.before)
  const after = await read(verified.after)
  const ownedBefore = appendRuntimeGitignoreRule(before)
  const maintenance = verified.after ? await prepareRuntimeGitignore(workspace) : undefined
  if (maintenance && maintenance.before !== after)
    throw new Error(
      "The verified ignore file changed during runtime projection. Restore the frozen baseline before retrying.",
    )
  const ownedAfter = maintenance?.after ?? after
  if (!verified.after) {
    if (saved || before.split(/\r?\n/).some((line) => line === ".agent-valley/" || line === "/.agent-valley/"))
      throw new Error(
        "Source integration cannot delete .gitignore while AV runtime protection is present. Retain its runtime rule and reconcile the verified change.",
      )
    if (!observed || observed.mode === "120000") return undefined
    const actual = await parallelGit(sourceWorkspace, ["cat-file", "blob", observed.oid])
    if (actual === ownedBefore)
      throw new Error(
        "Source integration cannot delete the runtime-protected .gitignore. Preserve AV's rule and reconcile the verified change.",
      )
    return undefined
  }
  if (
    !saved &&
    (!observed ||
      observed.mode === "120000" ||
      (observed.oid === verified.after.oid && observed.mode === verified.after.mode))
  )
    return undefined
  if (!saved) {
    const actual = observed ? await parallelGit(sourceWorkspace, ["cat-file", "blob", observed.oid]) : ""
    const modeBefore = verified.before?.mode ?? "100644"
    if (
      !(
        (actual === ownedBefore && observed?.mode === modeBefore) ||
        (actual === ownedAfter && observed?.mode === verified.after.mode)
      )
    )
      return undefined
    if (actual.includes("\ufffd") || before.includes("\ufffd") || after.includes("\ufffd"))
      throw new Error(
        "Runtime-ignore projection requires unchanged UTF-8 ignore-file text. Preserve its bytes and reconcile before retrying.",
      )
  }
  const blob = async (name: string, content: string, mode: Image["mode"]): Promise<Image> => {
    const path = join(directory, name)
    await artifact(path, content)
    return { mode, oid: (await parallelGit(workspace, ["hash-object", "-w", "--", path])).trim() }
  }
  const sourceBefore = await blob("gitignore-source-before", ownedBefore, verified.before?.mode ?? "100644")
  const sourceAfter = await blob("gitignore-source-after", ownedAfter, verified.after.mode)
  const projection: Projection = {
    path: ".gitignore",
    verifiedBefore: verified.before,
    verifiedAfter: verified.after,
    sourceBefore,
    sourceAfter,
  }
  if (saved && JSON.stringify(saved) !== JSON.stringify(projection))
    throw new Error(
      "The saved runtime-ignore projection differs from its verified and canonical source images. Restore the original receipt before retrying.",
    )
  return {
    projection,
    change: { path: ".gitignore", before: sourceBefore, after: sourceAfter },
    patch: await projectedPatch(workspace, directory, sourceBefore, sourceAfter),
  }
}
