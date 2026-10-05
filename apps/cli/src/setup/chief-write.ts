import { type ChiefConfig, chiefConfigSchema, mergeChiefConfig } from "@agent-valley/core/config/chief-schema"

/** Write explicit wizard changes without copying inherited global settings into the project. */
export function changedProjectChief(
  global: ChiefConfig | undefined,
  project: ChiefConfig | undefined,
  current: ChiefConfig | undefined,
): ChiefConfig {
  const previous = mergeChiefConfig(global, project)
  const fields = new Set(["reporting", "capture", "metric_sources", "metric_targets", "container_observation"])
  const changes = Object.fromEntries(
    Object.entries(current ?? {}).filter(
      ([key, value]) => fields.has(key) && JSON.stringify(value) !== JSON.stringify(previous[key as keyof ChiefConfig]),
    ),
  )
  return chiefConfigSchema.parse({ ...project, ...changes })
}
