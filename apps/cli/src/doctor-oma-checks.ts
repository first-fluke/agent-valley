/** Read-only OMA compatibility checks for `av doctor`. */
import { join } from "node:path"
import { parseTriggerTable } from "@agent-valley/core/config/workflow-router"
import type { ProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { OMA_RECEIPT_SCHEMA_VERSION, parseOmaCliVersion } from "@agent-valley/core/oma/receipt-adapter"
import type { CheckResult, DoctorDeps } from "./doctor-checks"

export function checkOma(project: ProjectConfig | null, deps: DoctorDeps): CheckResult[] {
  const strict = project?.oma?.mode === "strict"
  const order = !!project && !project.tracker && !project.linear && !project.github
  const task = project?.task
  const taskCheck: CheckResult =
    task?.kind === "analysis"
      ? task.report_path.includes("{{attempt.id}}") &&
        !task.report_path.startsWith("/") &&
        !task.report_path.split(/[\\/]/).includes("..")
        ? {
            id: "task.analysis",
            name: "Analysis report",
            status: "pass",
            message: "Current-attempt report path configured",
            critical: false,
          }
        : {
            id: "task.analysis",
            name: "Analysis report",
            status: "fail",
            message: "task.report_path must contain {{attempt.id}}",
            fix: "Set task.report_path to a relative path containing {{attempt.id}} in av.yaml.",
            critical: true,
          }
      : project?.verify?.command?.trim()
        ? {
            id: "task.code",
            name: "Code verification",
            status: "pass",
            message: "verify.command is configured",
            critical: false,
          }
        : order && !strict
          ? {
              id: "task.chief",
              name: "Goal verification",
              status: "pass",
              message: "Chief Director defines goal-specific checks before work",
              critical: false,
            }
          : {
              id: "task.code",
              name: "Code verification",
              status: "fail",
              message: "Code tasks require verify.command in av.yaml",
              fix: "Set verify.command to a deterministic check in av.yaml before running code tasks.",
              critical: true,
            }
  if (!strict) {
    return [
      taskCheck,
      {
        id: "oma.mode",
        name: "OMA completion evidence",
        status: "warn",
        message: order
          ? "OMA receipts are optional; Chief Director designs verification checks for each goal"
          : "OMA receipts are optional; code changes and verification or a current-attempt analysis report are still required",
        fix: "Set oma.mode: strict in av.yaml to require current OMA receipts.",
        critical: false,
      },
    ]
  }

  const results: CheckResult[] = [taskCheck]
  const omaPath = deps.resolveBinary("oma")
  let version: string | null = null
  if (omaPath) {
    try {
      version = parseOmaCliVersion(deps.getOmaVersion?.() ?? "") ?? null
    } catch {
      // Probe failures become a concrete compatibility check failure below.
    }
  }
  results.push(
    version !== null
      ? {
          id: "oma.cli",
          name: "OMA CLI availability",
          status: "pass",
          message: `${omaPath} (${version}); receipt schema v${OMA_RECEIPT_SCHEMA_VERSION} and current evidence are checked for each task`,
          critical: false,
        }
      : {
          id: "oma.cli",
          name: "OMA CLI availability",
          status: "fail",
          message: omaPath ? "OMA CLI did not return a valid version" : "oma not found on PATH",
          fix: "Run npm install -g oh-my-agent@latest, verify with oma --version, then rerun av doctor.",
          critical: true,
        },
  )

  const command = project?.verify?.command?.trim()
  results.push(
    command
      ? {
          id: "oma.verify",
          name: "OMA required verification",
          status: "pass",
          message: `verify.command is configured`,
          critical: false,
        }
      : {
          id: "oma.verify",
          name: "OMA required verification",
          status: "fail",
          message: "verify.command is missing from av.yaml",
          fix: "Set verify.command to a deterministic non-build check in av.yaml before using oma.mode: strict.",
          critical: true,
        },
  )

  const triggerPath = join(deps.cwd, ".agents", "hooks", "core", "triggers.json")
  let table = null
  try {
    table = parseTriggerTable(deps.readFileSync(triggerPath))
  } catch {
    // Missing or unreadable target table is an actionable strict-mode error.
  }
  if (!table) {
    results.push({
      id: "oma.triggers",
      name: "OMA trigger table",
      status: "fail",
      message: `${triggerPath} is missing, malformed, or uses an unsupported schema`,
      fix: "Install or update OMA in this project, then confirm .agents/hooks/core/triggers.json matches the supported schema.",
      critical: true,
    })
    return results
  }
  results.push({ id: "oma.triggers", name: "OMA trigger table", status: "pass", message: triggerPath, critical: false })

  const missing = Object.entries(table.workflows)
    .filter(([name, workflow]) => !workflow.persistent && !table.excludedWorkflows.includes(name))
    .map(([name]) => join(deps.cwd, ".agents", "workflows", `${name}.md`))
    .filter((path) => !deps.existsSync(path))
  results.push(
    missing.length === 0
      ? {
          id: "oma.workflows",
          name: "OMA workflow files",
          status: "pass",
          message: "All routed workflow files exist",
          critical: false,
        }
      : {
          id: "oma.workflows",
          name: "OMA workflow files",
          status: "fail",
          message: `Missing routed workflow files: ${missing.join(", ")}`,
          fix: "Reinstall or update OMA in this project, then rerun av doctor.",
          critical: true,
        },
  )
  return results
}
