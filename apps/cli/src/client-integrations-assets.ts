import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export function clientSkillAssetCandidates(moduleUrl = import.meta.url): string[] {
  return [
    fileURLToPath(new URL("./assets/skills/av/SKILL.md", moduleUrl)),
    fileURLToPath(new URL("../../../integrations/skills/av/SKILL.md", moduleUrl)),
  ]
}

export async function loadClientSkillAsset(candidates: string[]): Promise<{ path: string; content: string }> {
  for (const path of candidates) {
    let content: string
    try {
      content = await readFile(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw new Error(
        `Cannot read AV client skill at ${path}. Restore its file permissions, then rerun av integrations install.`,
      )
    }
    if (!content.startsWith("---\n") || !content.includes("AGENT_VALLEY_MANAGED_RUN"))
      throw new Error(
        `AV client skill at ${path} is invalid. Restore integrations/skills/av/SKILL.md from the Agent Valley checkout or reinstall the CLI package.`,
      )
    return { path, content }
  }
  throw new Error(
    `AV client skill is missing at ${candidates.join(" or ")}. Install from a complete Agent Valley checkout or CLI package, then rerun av integrations install.`,
  )
}

export async function copyClientSkillAsset(destinationRoot: string, sourceSkillRoot?: string): Promise<string> {
  const candidates = sourceSkillRoot ? [join(sourceSkillRoot, "SKILL.md")] : clientSkillAssetCandidates()
  const asset = await loadClientSkillAsset(candidates)
  const target = join(destinationRoot, "assets/skills/av/SKILL.md")
  await mkdir(dirname(target), { recursive: true })
  await copyFile(asset.path, target)
  return target
}
