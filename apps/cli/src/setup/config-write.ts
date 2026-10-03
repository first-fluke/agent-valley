import type { GlobalConfig, ProjectConfig } from "@agent-valley/core/config/yaml-loader"

/** Loaded config exposes normalized agent defaults; only actor is written to new files. */
export function canonicalConfig(config: GlobalConfig | ProjectConfig): Record<string, unknown> {
  const { agent, actor, ...rest } = config
  const defaults = agent ?? actor
  return { ...rest, ...(defaults ? { actor: defaults } : {}) }
}
