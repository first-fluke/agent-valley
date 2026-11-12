import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { lockRecord } from "../util/record-lock"
import { codeDeliveryPath } from "./code-delivery-contract"
import { integrateContentTransaction } from "./content-transaction"
import { type ContinuousBaseline, type Operation, operationIdSchema } from "./continuous-contract"
import { gitignoreProjectionSchema, projectContinuousGitignore } from "./continuous-gitignore"
import { productPath, regularFile, sourceRoot } from "./continuous-source-helpers"
import { validateContinuousBaseline } from "./continuous-workspace"
import { parallelDeliverySchema } from "./parallel-contract"
import { captureParallelBaseline, parallelGit, parallelTreeImages, writeParallelJson } from "./parallel-git"
import {
  MAX_SOURCE_PRODUCT_PATHS,
  type SourceIntegrationPolicy,
  type SourceIntegrationSummary,
} from "./source-integration-contract"

const receiptSchema = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  missionId: operationIdSchema,
  repositoryRoot: z.string().min(1),
  branch: z.string().min(1),
  sourceHead: z.string().regex(/^[a-f0-9]{40,64}$/),
  previousTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  nextTree: z.string().regex(/^[a-f0-9]{40,64}$/),
  verifiedFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  patchPath: parallelDeliverySchema.shape.patchPath,
  patchSha256: parallelDeliverySchema.shape.patchSha256,
  verifiedChanges: parallelDeliverySchema.shape.changes,
  sourceChanges: parallelDeliverySchema.shape.changes,
  gitignoreProjection: gitignoreProjectionSchema.optional(),
  alreadySatisfied: z.array(z.string().refine(codeDeliveryPath)).max(MAX_SOURCE_PRODUCT_PATHS),
  changes: parallelDeliverySchema.shape.changes,
  status: parallelDeliverySchema.shape.status,
  at: z.iso.datetime().optional(),
})

async function localDirectory(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!entry) await mkdir(path, { mode: 0o700 })
  const current = entry ?? (await lstat(path))
  if (current.isSymbolicLink() || !current.isDirectory() || (await realpath(path)) !== path)
    throw new Error(
      "Source integration storage redirects. Restore its original private local directory before retrying.",
    )
  return path
}

/** Pin the checked-out source; applying verified files never changes its branch, HEAD or index. */
export async function prepareSourceIntegration(
  repositoryRoot: string,
  operationId: string,
): Promise<Extract<SourceIntegrationPolicy, { mode: "worktree" }>> {
  operationIdSchema.parse(operationId)
  const root = await sourceRoot(repositoryRoot)
  const branch = (await parallelGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim()
  const head = (await parallelGit(root, ["rev-parse", "HEAD"])).trim()
  return { mode: "worktree", branch, head }
}

/** Disabling application cannot abandon a partially written or not-yet-accepted source transaction. */
export async function assertSettledSourceIntegrations(
  repositoryRoot: string,
  operationId: string,
  pendingMissionIds: string | string[] = [],
): Promise<void> {
  operationIdSchema.parse(operationId)
  let directory = await sourceRoot(repositoryRoot)
  for (const part of [".agent-valley", "operations", operationId, "source-integrations"]) {
    directory = join(directory, part)
    const entry = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!entry) return
    if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(directory)) !== directory)
      throw new Error(
        "Source integration storage redirects. Restore its original private directory before changing modes.",
      )
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    operationIdSchema.parse(entry.name)
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink() || !entry.isDirectory() || (await realpath(path)) !== path)
      throw new Error(
        "Source integration receipt storage redirects. Restore its original directory before changing modes.",
      )
    const raw = await regularFile(join(path, "integration.json"))
    if (!raw) {
      if ((await readdir(path)).length)
        throw new Error(
          "A source integration receipt is missing beside retained artifacts. Resume worktree integration and reconcile the original transaction before selecting snapshot-only.",
        )
      continue
    }
    const receipt = receiptSchema.parse(JSON.parse(raw.toString("utf8")))
    if (
      receipt.operationId !== operationId ||
      receipt.repositoryRoot !== repositoryRoot ||
      receipt.missionId !== entry.name
    )
      throw new Error("Source integration receipt identity changed. Restore the original record before changing modes.")
    const pending = typeof pendingMissionIds === "string" ? [pendingMissionIds] : pendingMissionIds
    if (receipt.status === "applying" || (receipt.status === "applied" && pending.includes(receipt.missionId)))
      throw new Error(
        "Source integration is partially applied or awaiting child acceptance. Resume worktree integration and reconcile its retained receipt before selecting snapshot-only.",
      )
  }
}

async function inspectPath(root: string, path: string): Promise<void> {
  let current = root
  const parts = path.split("/")
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index] ?? "")
    const entry = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!entry) return
    if (entry.isSymbolicLink() || (index === parts.length - 1 ? !entry.isFile() : !entry.isDirectory()))
      throw new Error(
        `Source integration path ${JSON.stringify(path)} redirects or is not a regular product file. Preserve it and reconcile before retrying.`,
      )
  }
}

async function sourcePatch(workspace: string, previous: string, next: string, paths: string[]): Promise<string> {
  let patch = ""
  for (let offset = 0; offset < paths.length; ) {
    const batch: string[] = []
    let bytes = 0
    while (offset < paths.length) {
      const path = paths[offset]
      if (!path) break
      const size = Buffer.byteLength(path) + 1
      if (bytes + size > 16_384 && batch.length) break
      batch.push(path)
      bytes += size
      offset += 1
    }
    patch += await parallelGit(workspace, [
      "--literal-pathspecs",
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      previous,
      next,
      "--",
      ...batch,
    ])
  }
  return patch
}

/** Apply only the verified cycle delta; unrelated source work and staging remain untouched. */
export async function integrateContinuousSource(
  operation: Operation,
  previous: ContinuousBaseline,
  next: ContinuousBaseline,
  signal?: AbortSignal,
): Promise<SourceIntegrationSummary> {
  signal?.throwIfAborted()
  const policy = operation.sourceIntegrationPolicy
  if (policy?.mode !== "worktree")
    throw new Error("Enable the operation's worktree source integration policy before applying a verified cycle.")
  const root = await sourceRoot(operation.repositoryRoot)
  operationIdSchema.parse(operation.id)
  const missionId = operationIdSchema.parse(next.missionId)
  if (!next.verifiedFingerprint)
    throw new Error("Source integration requires the completed child's verified snapshot fingerprint.")
  for (const snapshot of [previous, next]) {
    const verified = await validateContinuousBaseline(root, operation.id, snapshot.path)
    if (JSON.stringify(verified) !== JSON.stringify(snapshot))
      throw new Error(
        "Source integration snapshot differs from its original receipt. Restore the accepted baseline before retrying.",
      )
  }
  const gitDirectory = await realpath(
    resolve(root, (await parallelGit(root, ["rev-parse", "--git-common-dir"])).trim()),
  )
  const unlock = await lockRecord(
    join(gitDirectory, "agent-valley-delivery.lock"),
    "Source integration",
    "source-integration",
  )
  try {
    const assertIdentity = async () => {
      signal?.throwIfAborted()
      const current = await prepareSourceIntegration(root, operation.id)
      if (current.branch === policy.branch && current.head === policy.head) return
      // An operator who committed the already-applied worktree leaves a clean same-branch fast-forward;
      // re-pin to it instead of pausing the cycle. Anything else still needs explicit reconciliation.
      if (
        current.branch === policy.branch &&
        !(await parallelGit(root, ["status", "--porcelain"])).trim() &&
        (await parallelGit(root, ["merge-base", "--is-ancestor", policy.head, current.head]).then(
          () => true,
          () => false,
        ))
      ) {
        policy.head = current.head
        return
      }
      throw new Error(
        "Source branch or HEAD moved from the saved integration target. Preserve local changes and reconcile the pinned source before resuming.",
      )
    }
    await assertIdentity()
    let directory = root
    for (const part of [".agent-valley", "operations", operation.id, "source-integrations", missionId])
      directory = await localDirectory(directory, part)
    const recordPath = join(directory, "integration.json")
    const patchPath = join(directory, "changes.patch")
    const saved = await regularFile(recordPath)
    const before = await parallelTreeImages(next.path, previous.baselineTree)
    const after = await parallelTreeImages(next.path, next.baselineTree)
    const verifiedChanges = [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
      if (!productPath(path)) return []
      const base = before.get(path) ?? null
      const result = after.get(path) ?? null
      if (JSON.stringify(base) === JSON.stringify(result)) return []
      if (base?.mode === "120000" || result?.mode === "120000")
        throw new Error(
          `Source integration refuses symbolic link ${JSON.stringify(path)}. Preserve it and use regular product files before retrying.`,
        )
      return [{ path, before: base, after: result }]
    })
    if (verifiedChanges.length > MAX_SOURCE_PRODUCT_PATHS)
      throw new Error(
        `The verified cycle exceeds ${MAX_SOURCE_PRODUCT_PATHS} source product paths. Preserve its snapshot and split source integration into a smaller verified cycle before retrying.`,
      )
    const existing = saved ? receiptSchema.parse(JSON.parse(saved.toString("utf8"))) : undefined
    const source = await captureParallelBaseline(root)
    const images = await parallelTreeImages(root, source.tree)
    const projected = await projectContinuousGitignore(
      next.path,
      root,
      directory,
      verifiedChanges.find((change) => change.path === ".gitignore"),
      images.get(".gitignore"),
      existing?.gitignoreProjection,
    )
    const sourceChanges = verifiedChanges.map((change) =>
      change.path === ".gitignore" && projected ? projected.change : change,
    )
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const alreadySatisfied =
      existing?.alreadySatisfied ??
      sourceChanges.filter((change) => same(images.get(change.path) ?? null, change.after)).map((change) => change.path)
    if (
      new Set(alreadySatisfied).size !== alreadySatisfied.length ||
      alreadySatisfied.some((path) => !sourceChanges.some((change) => change.path === path))
    )
      throw new Error(
        "The already-satisfied source paths differ from the full verified cycle delta. Restore the original receipt before retrying.",
      )
    const changes = sourceChanges.filter((change) => !alreadySatisfied.includes(change.path))
    let patch = await sourcePatch(
      next.path,
      previous.baselineTree,
      next.baselineTree,
      changes.filter((change) => !projected || change.path !== ".gitignore").map((change) => change.path),
    )
    if (projected && changes.some((change) => change.path === ".gitignore")) patch += projected.patch
    const patchSha256 = createHash("sha256").update(patch).digest("hex")
    const identity = {
      version: 1 as const,
      operationId: operation.id,
      missionId,
      repositoryRoot: root,
      branch: policy.branch,
      sourceHead: policy.head,
      previousTree: previous.baselineTree,
      nextTree: next.baselineTree,
      verifiedFingerprint: next.verifiedFingerprint,
      patchPath,
      patchSha256,
      verifiedChanges,
      sourceChanges,
      gitignoreProjection: projected?.projection,
      alreadySatisfied,
      changes,
    }
    const receipt = existing ?? { ...identity, status: "prepared" as const, at: undefined as string | undefined }
    for (const [key, value] of Object.entries(identity))
      if (JSON.stringify(receipt[key as keyof typeof receipt]) !== JSON.stringify(value))
        throw new Error(
          "Source integration receipt identity or verified delta changed. Restore its original receipt before retrying.",
        )
    const existingPatch = await regularFile(patchPath)
    if (existingPatch) {
      if (!existingPatch.equals(Buffer.from(patch)))
        throw new Error("Source integration patch changed. Restore its original SHA256-bound bytes before retrying.")
    } else {
      if (saved)
        throw new Error("Source integration patch is missing. Restore its original private artifact before retrying.")
      await writeFile(patchPath, patch, { mode: 0o600, flag: "wx" })
    }
    const save = async () => {
      if (receipt.status === "applied") receipt.at ??= new Date().toISOString()
      await writeParallelJson(recordPath, receipt)
    }
    if (!saved) await save()
    await integrateContentTransaction(root, receipt, {
      save,
      conflict: (paths, detail) =>
        new Error(
          `${detail ?? "Source files overlap the verified cycle delta."} Paths: ${paths.join(", ")}. Source and isolated results were retained; reconcile before resuming.`,
        ),
      assertLive: async () => {
        await assertIdentity()
        for (const change of verifiedChanges) await inspectPath(root, change.path)
        if (alreadySatisfied.length) {
          const current = await captureParallelBaseline(root, { include: alreadySatisfied })
          const currentImages = await parallelTreeImages(root, current.tree)
          if (
            sourceChanges.some(
              (change) =>
                alreadySatisfied.includes(change.path) && !same(currentImages.get(change.path) ?? null, change.after),
            )
          )
            throw new Error(
              "An already-satisfied source path changed after preparation. Preserve all edits and reconcile the original receipt before retrying.",
            )
        }
        const staged = (
          await parallelGit(root, ["diff", "--cached", "--name-only", "-z", "--no-ext-diff", "--no-renames"])
        ).split("\0")
        if (changes.some((change) => staged.includes(change.path)))
          throw new Error(
            "A source integration target has staged operator changes. Preserve the index and reconcile those paths before resuming.",
          )
      },
    })
    // A verified path the source ignores (tracked by the child despite an ignore rule) was applied to disk
    // but is invisible to an ordinary snapshot; without naming it the applied cycle reads as a mismatch.
    const final = await captureParallelBaseline(root, { include: sourceChanges.map((change) => change.path) })
    const finalImages = await parallelTreeImages(root, final.tree)
    if (sourceChanges.some((change) => !same(finalImages.get(change.path) ?? null, change.after)))
      throw new Error(
        "Source files no longer match the full verified cycle delta. Preserve the source and its receipt before retrying.",
      )
    await assertIdentity()
    return {
      phase: changes.length ? "applied" : "unchanged",
      missionId,
      branch: policy.branch,
      sourceHead: policy.head,
      previousTree: previous.baselineTree,
      nextTree: next.baselineTree,
      patchSha256,
      paths: changes.map((change) => change.path),
      at: receipt.at ?? new Date().toISOString(),
    }
  } finally {
    await unlock()
  }
}

export { synchronizeContinuousBaselineWithSource } from "./continuous-baseline-sync"
