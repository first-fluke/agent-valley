import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import { drizzle } from "drizzle-orm/libsql"
import { migrate } from "drizzle-orm/libsql/migrator"
import { afterEach, beforeEach, expect, it } from "vitest"
import {
  copyTursoMigrationAssets,
  loadTursoMigrationAssets,
  resolveTursoMigrationDirectory,
  tursoMigrationAssetCandidates,
} from "./turso-migration-assets"

let root: string
const journal = {
  version: "7",
  dialect: "sqlite",
  entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag: "0000_fixture", breakpoints: true }],
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-migration-assets-"))
})
afterEach(async () => rm(root, { recursive: true, force: true }))

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
async function fixture(directory: string): Promise<void> {
  await put(join(directory, "meta/_journal.json"), JSON.stringify(journal))
  await put(join(directory, "0000_fixture.sql"), "create table fixture (id integer primary key);\n")
}

it("resolves source migrations without relying on the current directory", async () => {
  const checkout = join(root, "checkout with spaces")
  const source = join(checkout, "turso/migrations")
  await fixture(source)
  const candidates = tursoMigrationAssetCandidates(
    pathToFileURL(join(checkout, "packages/core/src/relay/turso-migration-assets.ts")).href,
  )
  expect(await resolveTursoMigrationDirectory(candidates)).toBe(source)
})

it("copies only declared runtime assets and migrates an isolated installed-package fixture", async () => {
  const source = join(root, "source")
  await fixture(source)
  await put(join(source, "unlisted-secret.sql"), "Do not package unlisted files")
  const distribution = join(root, "installed package/dist")
  const copied = await copyTursoMigrationAssets(distribution, source)
  const candidates = tursoMigrationAssetCandidates(pathToFileURL(join(distribution, "index.js")).href)
  const assets = await loadTursoMigrationAssets(candidates)
  expect(assets.directory).toBe(copied)
  expect(assets.files).toEqual(["meta/_journal.json", "0000_fixture.sql"])
  expect(await readFile(join(copied, "meta/_journal.json"), "utf8")).toBe(JSON.stringify(journal))
  await expect(readFile(join(copied, "unlisted-secret.sql"))).rejects.toMatchObject({ code: "ENOENT" })
  const client = createClient({ url: "file::memory:" })
  try {
    await migrate(drizzle(client), { migrationsFolder: await resolveTursoMigrationDirectory(candidates) })
    expect((await client.execute("select name from sqlite_master where name='fixture'")).rows).toHaveLength(1)
    expect((await client.execute("select hash from __drizzle_migrations")).rows).toHaveLength(1)
  } finally {
    client.close()
  }
})

it("prefers packaged migrations and fails closed on corrupt package assets", async () => {
  const candidates = tursoMigrationAssetCandidates(
    pathToFileURL(join(root, "node_modules/agent-valley/dist/index.js")).href,
  )
  const packaged = candidates[0] as string
  const fallback = candidates[1] as string
  await fixture(packaged)
  await fixture(fallback)
  expect(await resolveTursoMigrationDirectory(candidates)).toBe(packaged)
  await writeFile(join(packaged, "meta/_journal.json"), "corrupt")
  await expect(resolveTursoMigrationDirectory(candidates)).rejects.toThrow("invalid or incomplete")
})

it("rejects journal traversal, missing SQL and symbolic links", async () => {
  const directory = join(root, "migrations")
  await fixture(directory)
  await writeFile(
    join(directory, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: [{ ...journal.entries[0], tag: "../outside" }] }),
  )
  await expect(resolveTursoMigrationDirectory([directory])).rejects.toThrow("invalid or incomplete")
  await fixture(directory)
  const sql = join(directory, "0000_fixture.sql")
  await rm(sql)
  await expect(resolveTursoMigrationDirectory([directory])).rejects.toThrow("invalid or incomplete")
  const outside = join(root, "outside.sql")
  await put(outside, "create table unapproved(id integer);")
  await symlink(outside, sql)
  await expect(resolveTursoMigrationDirectory([directory])).rejects.toThrow("invalid or incomplete")
  await expect(resolveTursoMigrationDirectory([join(root, "missing")])).rejects.toThrow(
    "reinstall the complete CLI package",
  )
})
