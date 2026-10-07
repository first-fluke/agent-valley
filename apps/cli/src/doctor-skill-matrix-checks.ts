import { resolve } from "node:path"
import type { GlobalConfig, ProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { inspectSkillCompatibility } from "@agent-valley/core/oma/skill-matrix-adapter"
import type { CheckResult, DoctorDeps } from "./doctor-checks"

/** Cached audit diagnostics only: local OMA plan and CLI --version, never model execution. */
export async function checkSkillMatrix(
  project: ProjectConfig | null,
  global: GlobalConfig | null,
  deps: DoctorDeps,
): Promise<CheckResult[]> {
  const config = project?.oma?.skill_compatibility
  if (!config) return []
  const projectActor = project?.actor ?? project?.agent
  const globalActor = global?.actor ?? global?.agent
  const actorType = projectActor?.type ?? globalActor?.type ?? "claude"
  const model = projectActor?.model ?? (globalActor?.type === actorType ? globalActor.model : undefined)
  const inspection = await inspectSkillCompatibility(
    {
      reportPath: resolve(deps.cwd, config.report_path),
      maxAgeHours: config.max_age_hours,
      mode: config.mode,
    },
    resolve(deps.cwd, project?.workspace?.root ?? "."),
    undefined,
    [{ actorType, model }],
    deps.skillMatrix,
  )
  const route = inspection.routes[0]
  const status = route?.status ?? "unknown"
  return [
    {
      id: "oma.skill-compatibility",
      name: "OMA skill read-reference compatibility",
      status,
      message: `${config.mode}: ${actorType}/${model ?? "native default"}: ${route?.reason ?? "Evidence unavailable."} Scope: ${inspection.scope}. Work dispatch rechecks its own selected skills and candidates.`,
      ...(status !== "pass"
        ? {
            fix: "Generate a completed installed injected matrix with explicit models and set oma.skill_compatibility.report_path in av.yaml. av doctor never runs a live matrix.",
          }
        : {}),
      critical: config.mode === "require",
    },
  ]
}
