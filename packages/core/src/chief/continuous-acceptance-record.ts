import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { z } from "zod"
import { type Operation, operationIdSchema } from "./continuous-contract"

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/)
export const continuousAcceptanceSchema = z.strictObject({
  version: z.literal(1),
  operationId: operationIdSchema,
  repositoryRoot: z.string().min(1),
  missionId: operationIdSchema,
  cycle: z.number().int().min(1),
  baselinePath: z.string().min(1),
  commit: objectId,
  tree: objectId,
  completedAt: z.iso.datetime(),
})

/** Called after the operation checkpoint saves its accepted cycle. Never records unfinished snapshots. */
export async function recordContinuousAcceptance(operation: Operation): Promise<void> {
  const snapshot = operation.baseline
  const entry = operation.history.at(-1)
  if (!snapshot?.missionId || !entry || entry.missionId !== snapshot.missionId || entry.baselinePath !== snapshot.path)
    return
  const directory = join(
    operation.repositoryRoot,
    ".agent-valley",
    "operations",
    operation.id,
    "baselines",
    snapshot.missionId,
  )
  if (
    snapshot.operationId !== operation.id ||
    snapshot.repositoryRoot !== operation.repositoryRoot ||
    snapshot.path !== join(directory, "workspace") ||
    (await realpath(directory)) !== resolve(directory) ||
    (await realpath(operation.repositoryRoot)) !== operation.repositoryRoot
  )
    throw new Error("Acceptance journal paths changed. Restore the original accepted snapshot before continuing.")
  const record = continuousAcceptanceSchema.parse({
    version: 1,
    operationId: operation.id,
    repositoryRoot: operation.repositoryRoot,
    missionId: snapshot.missionId,
    cycle: operation.completedCycles,
    baselinePath: snapshot.path,
    commit: snapshot.commit,
    tree: snapshot.baselineTree,
    completedAt: entry.completedAt,
  })
  const path = join(directory, "acceptance.json")
  let existing: Awaited<ReturnType<typeof open>> | undefined
  try {
    existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const stat = await existing.stat()
    if (!stat.isFile() || stat.size > 16384) throw new Error("Unsupported acceptance journal receipt.")
    const saved = continuousAcceptanceSchema.parse(JSON.parse(await existing.readFile("utf8")))
    if (JSON.stringify(saved) !== JSON.stringify(record))
      throw new Error(
        "Acceptance journal differs from its saved cycle. Preserve both checkpoints and inspect their identity.",
      )
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  } finally {
    await existing?.close()
  }
  if (!(await lstat(dirname(path))).isDirectory())
    throw new Error("Acceptance journal requires its original private directory.")
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(record))
    await handle.sync()
  } finally {
    await handle.close()
  }
}
