import { readYamlFile } from "@agent-valley/core/config/yaml-file"
import {
  type GlobalConfig,
  globalConfigSchema,
  loadGlobalConfig,
  resolveGlobalConfigPath,
} from "@agent-valley/core/config/yaml-loader"

export const GLOBAL_CONFIG_REPAIR_WARNING =
  "Existing settings.yaml cannot be read or validated. Confirm saving to replace invalid settings; valid unrelated settings will be preserved."

export function readSetupGlobalConfig(): { config: GlobalConfig; invalid: boolean } {
  try {
    return { config: loadGlobalConfig() ?? {}, invalid: false }
  } catch {
    let raw: Record<string, unknown>
    try {
      raw = readYamlFile(resolveGlobalConfigPath()) ?? {}
    } catch {
      return { config: {}, invalid: true }
    }
    const candidate: Record<string, unknown> = {}
    for (const key of Object.keys(globalConfigSchema.shape)) {
      if (Object.hasOwn(raw, key)) candidate[key] = structuredClone(raw[key])
    }
    while (true) {
      const result = globalConfigSchema.safeParse(candidate)
      if (result.success) return { config: result.data, invalid: true }
      let removed = false
      for (const issue of result.error.issues) {
        let parent: unknown = candidate
        for (const key of issue.path.slice(0, -1)) {
          parent = typeof parent === "object" && parent !== null ? Reflect.get(parent, key) : undefined
        }
        const key = issue.path.at(-1)
        if (key !== undefined && typeof parent === "object" && parent !== null && Object.hasOwn(parent, key)) {
          removed = Reflect.deleteProperty(parent, key) || removed
        }
      }
      if (!removed) return { config: {}, invalid: true }
    }
  }
}
