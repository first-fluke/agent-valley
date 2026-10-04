import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export const pluginSchemaUrl = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
export const pluginMcpSchemaUrl = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"

const manifestSchema = z
  .object({
    $schema: z.literal(pluginSchemaUrl),
    name: z.literal("av"),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    description: z.string().min(1),
    author: z.object({ name: z.string().min(1) }).strict(),
    homepage: z.url(),
    repository: z.url(),
    license: z.string().min(1),
    keywords: z.array(z.string()),
  })
  .strict()

export type PluginManifest = z.infer<typeof manifestSchema>

export function pluginManifestAssetCandidates(moduleUrl = import.meta.url): string[] {
  return [
    fileURLToPath(new URL("./assets/plugin.json", moduleUrl)),
    fileURLToPath(new URL("../../../integrations/plugin.json", moduleUrl)),
  ]
}

export async function loadPluginManifestAsset(
  candidates = pluginManifestAssetCandidates(),
): Promise<{ path: string; manifest: PluginManifest }> {
  for (const path of candidates) {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(`Cannot read AV plugin metadata at ${path}. Restore its permissions and rerun av plugins export.`)
    }
    try {
      return { path, manifest: manifestSchema.parse(JSON.parse(content)) }
    } catch {
      throw new Error(
        `AV plugin metadata at ${path} is invalid. Restore integrations/plugin.json or reinstall the CLI package, then rerun av plugins export.`,
      )
    }
  }
  throw new Error(
    `AV plugin metadata is missing at ${candidates.join(" or ")}. Reinstall the complete CLI package or restore integrations/plugin.json, then rerun av plugins export.`,
  )
}

export async function copyPluginManifestAsset(destinationRoot: string, sourceManifest?: string): Promise<string> {
  const asset = await loadPluginManifestAsset(sourceManifest ? [sourceManifest] : undefined)
  const target = join(destinationRoot, "assets/plugin.json")
  await mkdir(dirname(target), { recursive: true })
  await copyFile(asset.path, target)
  return target
}
