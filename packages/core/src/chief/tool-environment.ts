import { z } from "zod"

const reserved = /^(?:PATH|HOME|USER|SHELL|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|LD_.+|DYLD_.+|GIT_.+|AGENT_VALLEY_.+)$/
export const toolEnvKeysSchema = z
  .array(
    z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,127}$/)
      .refine((key) => !reserved.test(key), "Tool credentials must not override runtime, Git or managed-run settings."),
  )
  .max(40)
  .refine((keys) => new Set(keys).size === keys.length, "Tool environment names must be unique.")

/** Only names are persisted. Values are resolved at spawn and never included in prompts or usage records. */
export function resolveToolEnvironment(
  keys: string[] = [],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of toolEnvKeysSchema.parse(keys)) {
    const value = source[key]
    if (!value)
      throw new Error(
        `Configured tool credential ${key} is missing. Export it before resuming, or remove its name from chief.tool_env_keys in av.yaml or settings.yaml.`,
      )
    result[key] = value
  }
  return result
}
