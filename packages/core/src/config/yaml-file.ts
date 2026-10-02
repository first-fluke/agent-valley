import { readFileSync } from "node:fs"
import { parse as parseYaml } from "yaml"

export function readYamlFile(path: string): Record<string, unknown> | null {
  try {
    const content = readFileSync(path, "utf-8")
    if (!content.trim()) return null
    const parsed = parseYaml(content)
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`)
  }
}
