import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const releaseManifests = [
  "apps/cli/package.json",
  "packages/core/package.json",
  "apps/dashboard/package.json",
  "integrations/plugin.json",
  "integrations/.claude-plugin/plugin.json",
  "integrations/.cursor-plugin/plugin.json",
  "integrations/qwen-extension.json",
]

export async function checkReleaseVersions(repository) {
  const readJson = async (path) => JSON.parse(await readFile(resolve(repository, path), "utf8"))
  const { version } = await readJson("package.json")
  if (typeof version !== "string" || !version.trim()) throw new Error("Set version in package.json.")
  const problems = []
  for (const path of releaseManifests) {
    const manifest = await readJson(path)
    if (manifest.version !== version)
      problems.push(`${path}: version=${String(manifest.version)}; expected ${version}.`)
  }
  const config = await readJson("release-please-config.json")
  const extraFiles = config.packages?.["."]?.["extra-files"] ?? []
  for (const path of releaseManifests) {
    const updated = extraFiles.some((entry) =>
      typeof entry === "string"
        ? entry === path && path.endsWith("package.json")
        : entry.path === path && entry.type === "json" && entry.jsonpath === "$.version",
    )
    if (!updated) problems.push(`${path}: missing version update in release-please-config.json extra-files.`)
  }
  if (problems.length)
    throw new Error(
      `${problems.join("\n")}\nSynchronize release manifests and configure release-please before publishing.`,
    )
  return version
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = await checkReleaseVersions(resolve(process.argv[2] ?? process.cwd()))
    console.log(`Release manifests agree: ${version}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
