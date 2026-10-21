import { copyFile, lstat, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const TURSO_MIGRATION_ASSET_PATH = "assets/turso/migrations"
const journalSchema = z.object({
  version: z.string().min(1),
  dialect: z.literal("sqlite"),
  entries: z
    .array(
      z.object({
        idx: z.number().int().nonnegative(),
        version: z.string().min(1),
        when: z.number().int().nonnegative(),
        tag: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/),
        breakpoints: z.boolean(),
      }),
    )
    .min(1)
    .max(1_000),
})

export function tursoMigrationAssetCandidates(moduleUrl = import.meta.url): string[] {
  return [
    fileURLToPath(new URL(`./${TURSO_MIGRATION_ASSET_PATH}`, moduleUrl)),
    fileURLToPath(new URL("../../../../turso/migrations", moduleUrl)),
  ]
}

async function regularFile(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(
      `Turso migration asset ${path} must be a regular file. Restore the checkout or reinstall the CLI package.`,
    )
}

/** Only journal-declared SQL and the runtime journal enter the published package. */
export async function loadTursoMigrationAssets(
  candidates = tursoMigrationAssetCandidates(),
): Promise<{ directory: string; files: string[] }> {
  for (const directory of candidates) {
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(
        `Cannot read Turso migrations at ${directory}. Restore its permissions or reinstall the CLI package.`,
      )
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        `Turso migration directory ${directory} must be a regular directory. Restore the checkout or reinstall the CLI package.`,
      )
    try {
      const meta = await lstat(join(directory, "meta"))
      if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error("Invalid migration metadata directory")
      const journalPath = join(directory, "meta/_journal.json")
      await regularFile(journalPath)
      const journal = journalSchema.parse(JSON.parse(await readFile(journalPath, "utf8")))
      const tags = journal.entries.map((entry) => entry.tag)
      if (new Set(tags).size !== tags.length) throw new Error("Duplicate migration tags")
      const files = ["meta/_journal.json", ...tags.map((tag) => `${tag}.sql`)]
      for (const file of files.slice(1)) {
        await regularFile(join(directory, file))
        if (!(await readFile(join(directory, file), "utf8")).trim()) throw new Error("Empty migration SQL")
      }
      return { directory, files }
    } catch {
      throw new Error(
        `Turso migration assets at ${directory} are invalid or incomplete. Restore turso/migrations from the checkout or reinstall the complete CLI package.`,
      )
    }
  }
  throw new Error(
    `Turso migrations are missing at ${candidates.join(" or ")}. Restore turso/migrations from the checkout or reinstall the complete CLI package.`,
  )
}

export async function resolveTursoMigrationDirectory(candidates = tursoMigrationAssetCandidates()): Promise<string> {
  return (await loadTursoMigrationAssets(candidates)).directory
}

export async function copyTursoMigrationAssets(destinationRoot: string, sourceDirectory?: string): Promise<string> {
  const assets = await loadTursoMigrationAssets(sourceDirectory ? [sourceDirectory] : undefined)
  const target = join(destinationRoot, TURSO_MIGRATION_ASSET_PATH)
  for (const file of assets.files) {
    const destination = join(target, file)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(assets.directory, file), destination)
  }
  return target
}
