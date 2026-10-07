import { posix } from "node:path"
import { defaultSkillMatrixDeps, parseSkillMatrix, type SkillMatrixDeps } from "./skill-matrix-io"
import type {
  MatrixInspection,
  MatrixRoute,
  MatrixRouteResult,
  MatrixSkill,
  SkillCompatibilityPolicy,
  SkillMatrixReport,
} from "./skill-matrix-schema"

export type { SkillMatrixDeps } from "./skill-matrix-io"
export { defaultSkillMatrixDeps } from "./skill-matrix-io"
export type { MatrixInspection, MatrixRoute, MatrixRouteResult, SkillCompatibilityPolicy } from "./skill-matrix-schema"

const scope = "installed injected read-reference audit; not AV runtime or task-quality certification" as const
const safeNames = /^[a-z0-9][a-z0-9-]{0,127}$/
const remediation =
  "Regenerate the installed injected matrix with explicit models, then set oma.skill_compatibility.report_path in av.yaml."
export const matrixRouteKey = (route: MatrixRoute): string => `${route.actorType}\0${route.model ?? ""}`

function sourceProblem(report: SkillMatrixReport): string | undefined {
  if (
    report.sourceKind !== "installed" ||
    report.delivery !== "injected" ||
    report.auditScope !== "read-reference" ||
    !report.bundle
  )
    return "Evidence is not an installed, injected, read-reference audit. Synthetic probes cannot authorize installed skills."
  return undefined
}

function sameCoverage(a: MatrixSkill, b: MatrixSkill): boolean {
  const sorted = (items: string[]) => JSON.stringify([...items].sort())
  return (
    a.hash === b.hash &&
    a.caseId === b.caseId &&
    sorted(a.requiredFiles) === sorted(b.requiredFiles) &&
    sorted(a.missingFiles) === sorted(b.missingFiles) &&
    JSON.stringify(a.excludedReferences) === JSON.stringify(b.excludedReferences)
  )
}

function assessRoute(
  report: SkillMatrixReport,
  plan: SkillMatrixReport,
  skills: readonly string[],
  route: MatrixRoute,
  version: string | null,
): MatrixRouteResult {
  const result = (status: MatrixRouteResult["status"], reason: string): MatrixRouteResult => ({
    ...route,
    status,
    reason,
  })
  if (route.actorType !== "claude" && route.actorType !== "codex")
    return result("unknown", "This matrix protocol measures only Claude and Codex.")
  if (!route.model)
    return result("unknown", "The candidate uses an unpinned native model default; it cannot match a measured model.")
  if (!version) return result("unknown", "The current native CLI version could not be verified.")
  for (const name of skills) {
    const current = plan.bundle?.skills.find((entry) => entry.name === name)
    const saved = report.bundle?.skills.find((entry) => entry.name === name)
    if (!current || !saved) return result("unknown", `Skill ${name} has no complete installed audit coverage.`)
    if (!sameCoverage(current, saved))
      return result("unknown", `Skill ${name} content or reference coverage changed after the audit.`)
    if (
      current.missingFiles.length ||
      current.excludedReferences.length ||
      saved.missingFiles.length ||
      saved.excludedReferences.length
    )
      return result("unknown", `Skill ${name} has missing or excluded references; complete its audit coverage first.`)
    if (!report.cases.some((entry) => entry.id === saved.caseId && entry.skill === name))
      return result("unknown", `Skill ${name} required case is absent from the measured selection.`)
    const cell = report.cells.find((entry) => entry.caseId === saved.caseId && entry.vendor === route.actorType)
    if (!cell || cell.skill !== name || cell.contentHash !== current.hash)
      return result("unknown", `Skill ${name} lacks a matching measured vendor cell.`)
    if (cell.cliVersion !== version)
      return result("unknown", `Skill ${name} was measured with a different or unknown native CLI version.`)
    if (cell.model !== route.model)
      return result("unknown", `Skill ${name} was measured with a different or unknown reported model.`)
    if (cell.status !== "pass" || !cell.checks.length || cell.checks.some((check) => check.status !== "pass"))
      return result(
        cell.status === "fail" ? "fail" : "unknown",
        `Skill ${name} audit is ${cell.status}; passing read-reference evidence is required.`,
      )
    const entry = `${name}/SKILL.md`
    if (!current.requiredFiles.includes(entry))
      return result("unknown", `Skill ${name} audit omits its installed SKILL.md.`)
    const required = [
      "process",
      "output",
      "content",
      "integrity",
      "reference-coverage",
      ...current.requiredFiles
        .filter((file) => file !== entry)
        .map((file) => `reference:${posix.relative(name, file)}`),
    ]
    if (
      required.some(
        (id) =>
          !cell.checks.some(
            (check) =>
              check.id === id &&
              check.status === "pass" &&
              (id === "content" || id.startsWith("reference:") ? check.proof === "read" : true),
          ),
      )
    )
      return result("unknown", `Skill ${name} audit lacks a mandatory successful read-reference check.`)
  }
  return result("pass", "All selected skills have current passing installed injected read-reference evidence.")
}

/** Read cached evidence and run local plans/version probes only. Never invokes --live. */
export async function inspectSkillCompatibility(
  policy: SkillCompatibilityPolicy,
  workspace: string,
  selectedSkills: readonly string[] | undefined,
  routes: readonly MatrixRoute[],
  deps: SkillMatrixDeps = defaultSkillMatrixDeps,
  signal?: AbortSignal,
): Promise<MatrixInspection> {
  const unknown = (reason: string): MatrixInspection => ({
    scope,
    routes: routes.map((route) => ({ ...route, status: "unknown", reason })),
  })
  if (selectedSkills?.length === 0)
    return {
      scope,
      routes: routes.map((route) => ({
        ...route,
        status: "pass",
        reason: "No skills selected; no compatibility claim is required.",
      })),
    }
  try {
    if (signal?.aborted) throw new Error("Interrupted")
    const report = parseSkillMatrix(await deps.readReport(policy.reportPath))
    const source = sourceProblem(report)
    if (source) return unknown(source)
    if (report.mode !== "live" || report.status !== "completed")
      return unknown("The report is not a completed live measurement; a plan is unmeasured.")
    const age = deps.now() - Date.parse(report.createdAt)
    if (age < -60_000 || age > policy.maxAgeHours * 3_600_000)
      return unknown("The cached matrix is stale or has a future timestamp.")
    if (report.host.platform !== deps.platform || report.host.arch !== deps.arch)
      return unknown("The matrix host platform or architecture differs from this runtime.")
    const skills = [...new Set(selectedSkills ?? report.bundle?.skills.map((entry) => entry.name) ?? [])]
    if (!skills.length || skills.length > 100 || skills.some((name) => !safeNames.test(name)))
      return unknown("Select a bounded list of valid installed skill names.")
    const plan = parseSkillMatrix(await deps.plan(workspace, skills, signal))
    if (sourceProblem(plan) || plan.mode !== "plan" || plan.status !== "planned")
      return unknown("OMA did not return a supported installed injected plan.")
    if (plan.omaVersion !== report.omaVersion)
      return unknown("The OMA version changed after measurement; refresh the cached matrix.")
    if (plan.host.platform !== deps.platform || plan.host.arch !== deps.arch)
      return unknown("The current OMA plan host does not match this runtime.")
    const versions = new Map<string, string | null>()
    for (const route of routes) {
      if (versions.has(route.actorType) || (route.actorType !== "claude" && route.actorType !== "codex")) continue
      try {
        versions.set(route.actorType, await deps.cliVersion(route.actorType, signal))
      } catch {
        versions.set(route.actorType, null)
      }
    }
    if (signal?.aborted) throw new Error("Interrupted")
    return {
      scope,
      routes: routes.map((route) => assessRoute(report, plan, skills, route, versions.get(route.actorType) ?? null)),
    }
  } catch {
    if (signal?.aborted) throw new Error("Skill compatibility inspection interrupted before Actor launch.")
    return unknown(`The cached report or local OMA plan could not be validated. ${remediation}`)
  }
}

export function assertCompatibleRoute(route: MatrixRoute, inspection: MatrixInspection): void {
  const result = inspection.routes.find((entry) => matrixRouteKey(entry) === matrixRouteKey(route))
  if (result?.status !== "pass")
    throw new Error(
      `Skill compatibility required for ${route.actorType}/${route.model ?? "native default"}: ${result?.reason ?? "no matching evidence"} ${remediation}`,
    )
}
