/**
 * Dashboard config — delegates to core YAML config loader.
 * Replaces the previous @t3-oss/env-nextjs approach.
 */

import { loadConfig, type Config } from "@agent-valley/core/config/yaml-loader"

export { type Config }

/** Load config from settings.yaml (global) + av.yaml (project root). */
export function toOrchestratorConfig(projectRoot?: string): Config {
  return loadConfig(projectRoot)
}
