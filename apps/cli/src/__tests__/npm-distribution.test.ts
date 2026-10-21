import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cliBuildConfig } from "../cli-build-config"
import { distributionManifest, externalRuntimePackages, stageNpmDistribution } from "../npm-distribution"

const engines = { node: ">=26.10.0", bun: ">=1.4.2" }
const core = { dependencies: { "@libsql/client": "^0.18.99", "drizzle-orm": "^0.45.99" } }
const journal = {
  version: "7",
  dialect: "sqlite",
  entries: [{ idx: 0, version: "6", when: 1_700_000_000_000, tag: "0000_fixture", breakpoints: true }],
}
const source = {
  name: "agent-valley",
  version: "9.8.7",
  type: "module",
  license: "AGPL-3.0-only",
  description: "Fixture CLI",
  repository: { type: "git", url: "https://github.com/first-fluke/agent-valley.git", directory: "apps/cli" },
  bin: { av: "dist/index.js", "agent-valley": "dist/index.js" },
  files: ["dist"],
  scripts: { build: "bun run build.ts", prepublishOnly: "bun run build" },
  dependencies: { "@agent-valley/core": "workspace:*", commander: "^15.0.0" },
  devDependencies: { vitest: "^5.0.3" },
}
const directories: string[] = []

afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "av-npm-manifest-"))
  directories.push(root)
  const cli = join(root, "apps/cli")
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ engines }),
    "packages/core/package.json": JSON.stringify(core),
    LICENSE: "Fixture AGPL license\n",
    "README.md": "# Fixture CLI\n",
    "apps/cli/package.json": JSON.stringify(source),
    "apps/cli/dist/index.js": "#!/usr/bin/env node\nconsole.log('fixture')\n",
    "apps/cli/dist/supervisor.js": "#!/usr/bin/env node\nconsole.log('fixture supervisor')\n",
    "apps/cli/dist/assets/skills/av/SKILL.md": "---\nname: av\n---\nFixture skill\n",
    "apps/cli/dist/assets/plugin.json": JSON.stringify({ name: "av", version: source.version }),
    "apps/cli/dist/assets/LICENSE": "Fixture AGPL license\n",
    "apps/cli/dist/assets/turso/migrations/meta/_journal.json": JSON.stringify(journal),
    "apps/cli/dist/assets/turso/migrations/0000_fixture.sql": "create table fixture(id integer);\n",
    "apps/cli/dist/assets/turso/migrations/unlisted-secret.sql": "Must not enter the distribution\n",
    "apps/cli/dist/debug.txt": "Must not enter the distribution\n",
  }
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  return { root, cli }
}

describe("npm distribution", () => {
  it("retains publish identity and runtime requirements without npm workspace resolution or lifecycle hooks", () => {
    const original = structuredClone(source)
    const manifest = distributionManifest(source, engines, core)
    expect(manifest).toMatchObject({
      name: source.name,
      version: source.version,
      type: "module",
      license: source.license,
      repository: source.repository,
      bin: source.bin,
      engines,
      files: ["dist", "LICENSE", "README.md"],
    })
    expect(manifest.dependencies).toEqual({ "@libsql/client": core.dependencies["@libsql/client"] })
    expect(manifest).not.toHaveProperty("devDependencies")
    expect(manifest).not.toHaveProperty("scripts")
    expect(JSON.stringify(manifest)).not.toContain("workspace:")
    expect(source).toEqual(original)
  })

  it("omits inherited workspace/private/peer/optional development metadata from the bundled package", () => {
    const manifest = distributionManifest(
      {
        ...source,
        private: true,
        workspaces: ["packages/*"],
        peerDependencies: { "@agent-valley/core": "workspace:*" },
        peerDependenciesMeta: { "@agent-valley/core": { optional: true } },
        optionalDependencies: { "@agent-valley/core": "workspace:*" },
        bundleDependencies: ["@agent-valley/core"],
        bundledDependencies: ["@agent-valley/core"],
      },
      engines,
      core,
    )
    for (const key of [
      "private",
      "workspaces",
      "peerDependencies",
      "peerDependenciesMeta",
      "optionalDependencies",
      "bundleDependencies",
      "bundledDependencies",
    ])
      expect(manifest).not.toHaveProperty(key)
  })

  it.each([{ name: "wrong-package" }, { version: "bad" }, { type: "commonjs" }])(
    "rejects invalid package identity before staging: %j",
    (patch) => {
      expect(() => distributionManifest({ ...source, ...patch }, engines, core)).toThrow("apps/cli/package.json")
    },
  )

  it("keeps the native driver external while bundling application and ORM modules", () => {
    const config = cliBuildConfig("/checkout/apps/cli")
    expect(config).toMatchObject({
      target: "node",
      format: "esm",
      packages: "bundle",
      outdir: "/checkout/apps/cli/dist",
    })
    expect(config.entrypoints).toEqual(["/checkout/apps/cli/src/index.ts", "/checkout/apps/cli/src/supervisor.ts"])
    expect(config.external).toEqual(externalRuntimePackages.flatMap((name) => [name, `${name}/*`]))
    expect(config.external).not.toContain("drizzle-orm")
    expect(config.external).not.toContain("@agent-valley/core")
  })

  it.each([{}, { dependencies: {} }, { dependencies: { "@libsql/client": "workspace:*" } }])(
    "rejects missing or workspace native-driver versions before staging",
    (metadata) => {
      expect(() => distributionManifest(source, engines, metadata)).toThrow(
        "dependencies.@libsql/client in packages/core/package.json",
      )
    },
  )

  it("reports the missing engine key in the root manifest", () => {
    expect(() => distributionManifest(source, { ...engines, node: "" }, core)).toThrow("engines.node and engines.bun")
  })

  it("stages checked bundles, assets and legal files while leaving source development metadata untouched", async () => {
    const { root, cli } = await fixture()
    const before = await readFile(join(cli, "package.json"), "utf8")
    const destination = await stageNpmDistribution(cli, root)
    expect(destination).toBe(join(cli, "dist/npm"))
    const manifest = JSON.parse(await readFile(join(destination, "package.json"), "utf8"))
    expect(manifest.dependencies).toEqual({ "@libsql/client": core.dependencies["@libsql/client"] })
    expect(manifest.engines).toEqual(engines)
    for (const file of [
      "dist/index.js",
      "dist/supervisor.js",
      "dist/assets/skills/av/SKILL.md",
      "dist/assets/plugin.json",
      "dist/assets/LICENSE",
      "dist/assets/turso/migrations/meta/_journal.json",
      "dist/assets/turso/migrations/0000_fixture.sql",
    ])
      expect(await readFile(join(destination, file), "utf8")).toBe(await readFile(join(cli, file), "utf8"))
    expect(await readFile(join(destination, "LICENSE"), "utf8")).toBe(await readFile(join(root, "LICENSE"), "utf8"))
    expect(await readFile(join(destination, "README.md"), "utf8")).toBe(await readFile(join(root, "README.md"), "utf8"))
    expect((await lstat(join(destination, "dist/index.js"))).mode & 0o111).toBe(0o111)
    await expect(lstat(join(destination, "dist/debug.txt"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(lstat(join(destination, "dist/assets/turso/migrations/unlisted-secret.sql"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(join(cli, "package.json"), "utf8")).toBe(before)
    await chmod(join(destination, "dist/index.js"), 0o600)
    await stageNpmDistribution(cli, root)
    expect((await lstat(join(destination, "dist/index.js"))).mode & 0o111).toBe(0o111)
  })

  it("fails on missing files and mismatched plugin versions before clearing an existing stage", async () => {
    const { root, cli } = await fixture()
    const destination = await stageNpmDistribution(cli, root)
    const sentinel = join(destination, "retained.txt")
    await writeFile(sentinel, "retain until valid replacement")
    await writeFile(join(cli, "dist/assets/plugin.json"), JSON.stringify({ version: "1.2.3" }))
    await expect(stageNpmDistribution(cli, root)).rejects.toThrow("plugin and CLI versions differ")
    expect(await readFile(sentinel, "utf8")).toBe("retain until valid replacement")
    await rm(join(cli, "dist/assets/LICENSE"))
    await expect(stageNpmDistribution(cli, root)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(sentinel, "utf8")).toBe("retain until valid replacement")
  })

  it("retains an existing stage when a declared migration asset is missing or links elsewhere", async () => {
    const { root, cli } = await fixture()
    const destination = await stageNpmDistribution(cli, root)
    const sentinel = join(destination, "retained.txt")
    await writeFile(sentinel, "retain until valid replacement")
    const sql = join(cli, "dist/assets/turso/migrations/0000_fixture.sql")
    await rm(sql)
    await expect(stageNpmDistribution(cli, root)).rejects.toThrow("invalid or incomplete")
    expect(await readFile(sentinel, "utf8")).toBe("retain until valid replacement")
    await symlink(join(root, "LICENSE"), sql)
    await expect(stageNpmDistribution(cli, root)).rejects.toThrow("invalid or incomplete")
    expect(await readFile(sentinel, "utf8")).toBe("retain until valid replacement")
  })

  it("does not follow symlinks into unapproved distribution input", async () => {
    const { root, cli } = await fixture()
    const asset = join(cli, "dist/assets/LICENSE")
    await rm(asset)
    await symlink(join(root, "LICENSE"), asset)
    await expect(stageNpmDistribution(cli, root)).rejects.toThrow("expected a regular distribution file")
  })
})
