import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { loadTursoMigrationAssets, TURSO_MIGRATION_ASSET_PATH } from "@agent-valley/core/relay/turso-migration-assets"

type PackageMetadata = Record<string, unknown>
export const externalRuntimePackages = ["@libsql/client"] as const

function externalRuntimeDependencies(core: PackageMetadata): Record<string, string> {
  const dependencies = core.dependencies
  const result: Record<string, string> = {}
  for (const name of externalRuntimePackages) {
    const version =
      typeof dependencies === "object" && dependencies !== null ? Reflect.get(dependencies, name) : undefined
    if (typeof version !== "string" || !version.trim() || /^(workspace|file|link|catalog):/.test(version))
      throw new Error(
        `Set dependencies.${name} in packages/core/package.json to a published registry version before staging the CLI.`,
      )
    result[name] = version
  }
  return result
}
export interface DistributionEngines {
  node: string
  bun: string
}

const developmentFields = [
  "private",
  "workspaces",
  "scripts",
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundledDependencies",
  "bundleDependencies",
] as const

/** Bundle application modules; retain only the native driver as a registry dependency. */
export function distributionManifest(
  source: PackageMetadata,
  engines: DistributionEngines,
  core: PackageMetadata,
): PackageMetadata {
  if (
    source.name !== "agent-valley" ||
    typeof source.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(source.version) ||
    source.type !== "module"
  ) {
    throw new Error("Restore the agent-valley name, version and module type in apps/cli/package.json before building.")
  }
  if (!engines?.node?.trim() || !engines?.bun?.trim())
    throw new Error("Set engines.node and engines.bun in the root package.json before building the CLI distribution.")
  const manifest: PackageMetadata = {
    ...source,
    engines: { ...engines },
    bin: { av: "dist/index.js", "agent-valley": "dist/index.js" },
    files: ["dist", "LICENSE", "README.md"],
  }
  for (const field of developmentFields) delete manifest[field]
  manifest.dependencies = externalRuntimeDependencies(core)
  return manifest
}

async function metadata(path: string): Promise<PackageMetadata> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"))
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path}: expected a package metadata object. Restore the manifest and rerun the CLI build.`)
  return value as PackageMetadata
}

/** Stage only checked distribution files, retaining the source manifest and its workspace dependencies. */
export async function stageNpmDistribution(cliRoot: string, repositoryRoot: string): Promise<string> {
  const source = await metadata(join(cliRoot, "package.json"))
  const runtime = await metadata(join(repositoryRoot, "package.json"))
  const core = await metadata(join(repositoryRoot, "packages/core/package.json"))
  const manifest = distributionManifest(source, runtime.engines as DistributionEngines, core)
  const migrations = await loadTursoMigrationAssets([join(cliRoot, "dist", TURSO_MIGRATION_ASSET_PATH)])
  const files = [
    "dist/index.js",
    "dist/supervisor.js",
    "dist/assets/skills/av/SKILL.md",
    "dist/assets/plugin.json",
    "dist/assets/LICENSE",
    ...migrations.files.map((file) => join("dist", TURSO_MIGRATION_ASSET_PATH, file)),
  ]
  const copies = [
    ...files.map((file) => ({ source: join(cliRoot, file), target: file })),
    { source: join(repositoryRoot, "LICENSE"), target: "LICENSE" },
    { source: join(repositoryRoot, "README.md"), target: "README.md" },
  ]
  for (const copy of copies) {
    const info = await lstat(copy.source)
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`${copy.source}: expected a regular distribution file. Restore it and rerun the CLI build.`)
  }
  const plugin = await metadata(join(cliRoot, "dist/assets/plugin.json"))
  if (plugin.version !== manifest.version)
    throw new Error(
      "AV plugin and CLI versions differ. Synchronize plugin metadata before building the CLI distribution.",
    )
  const destination = join(cliRoot, "dist/npm")
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const copy of copies) {
    const target = join(destination, copy.target)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(copy.source, target)
  }
  await chmod(join(destination, "dist/index.js"), 0o755)
  await chmod(join(destination, "dist/supervisor.js"), 0o755)
  await writeFile(join(destination, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return destination
}
