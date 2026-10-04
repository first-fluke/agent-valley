import { join, parse as parsePath, resolve } from "node:path"
import { AGENT_LOGIN_HINT } from "../doctor-checks"
import { prepareNoninteractiveConfig, validateNoninteractiveOptions } from "./noninteractive-config"
import { noninteractiveSetupDefaults } from "./noninteractive-runtime"
import type { NoninteractiveSetupDependencies, NoninteractiveSetupResult, SetupOptions } from "./noninteractive-types"

export type { NoninteractiveSetupDependencies, NoninteractiveSetupResult, SetupOptions } from "./noninteractive-types"

function rerunCommand(result: NoninteractiveSetupResult, options: SetupOptions): string {
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return `cd ${quote(result.projectRoot)} && av setup --yes --actor ${result.chief.actorType} --model ${quote(result.chief.model ?? "")} --workspace ${quote(result.workspace ?? result.projectRoot)} --oma ${options.oma ?? "prepare"} --json`
}

export async function setupNoninteractive(
  options: SetupOptions,
  overrides: Partial<NoninteractiveSetupDependencies> = {},
): Promise<NoninteractiveSetupResult> {
  const deps = { ...noninteractiveSetupDefaults(), ...overrides }
  const result: NoninteractiveSetupResult = {
    version: 1,
    status: "failed",
    exitCode: 1,
    projectRoot: resolve(deps.projectRoot),
    workspace: null,
    config: {
      project: join(resolve(deps.projectRoot), "av.yaml"),
      global: resolve(deps.globalConfigPath),
      saved: false,
    },
    chief: {
      actorType: null,
      model: null,
      actorSource: null,
      modelSource: "native-default",
      runtimeIdentity: null,
      readiness: "not_checked",
      message: "Readiness has not been checked.",
    },
    oma: { status: "not_started", message: "OMA preparation has not started." },
    integrations: { status: "not_started", clients: [], files: [] },
    nextActions: [],
  }
  try {
    validateNoninteractiveOptions(options)
    if (deps.env.AGENT_VALLEY_MANAGED_RUN === "1")
      throw new Error(
        "An AV-managed Chief Director or Actor cannot reconfigure its orchestrator. Return this setup request to the supervising caller and run av setup --yes from an authorized standalone session.",
      )
    const config = await prepareNoninteractiveConfig(options, deps)
    result.projectRoot = config.projectRoot
    result.workspace = config.workspace
    result.config.project = config.projectPath
    result.config.global = config.globalPath
    result.chief = config.chief

    // Reject current integration conflicts before installing providers or changing OMA/configuration.
    result.integrations.status = "failed"
    await deps.prepareIntegrations(config.workspace, config.projectRoot)
    result.integrations.status = "not_started"
    const selected = config.chief.actorType
    if (!selected) throw new Error("actor.type is missing. Rerun av setup --yes --actor <current-vendor>.")
    let availability = await deps.inspectActor(selected)
    if (availability.readiness === "unavailable") {
      const installation = await deps.installActor(selected)
      if (installation.success) availability = await deps.inspectActor(selected)
      else result.nextActions.push(installation.message)
    }
    result.chief.readiness = availability.readiness
    result.chief.message = availability.reason
    if (availability.readiness !== "ready") result.nextActions.push(AGENT_LOGIN_HINT[selected])

    if (options.oma === "skip") {
      result.oma = {
        status: "skipped",
        message: "OMA preparation was explicitly skipped; installed skills were not validated.",
      }
    } else {
      result.oma = {
        status: "failed",
        message: "OMA preparation did not complete. Rerun av setup --yes after repairing the environment.",
      }
      const oma = await deps.prepareOma(config.workspace).catch(() => ({ success: false, message: result.oma.message }))
      result.oma = { status: oma.success ? "prepared" : "failed", message: oma.message }
    }

    // OMA may add unrelated client settings. Recompute their snapshots before the single atomic save.
    result.integrations.status = "failed"
    const integrations = await deps.prepareIntegrations(config.workspace, config.projectRoot)
    const changed = await deps.applyFiles(parsePath(config.projectRoot).root, [...config.files, ...integrations.files])
    result.config.saved = true
    const clientPaths = new Set(integrations.files.map((file) => file.path))
    result.integrations = {
      status: "installed",
      clients: integrations.clients,
      files: changed.filter((path) => clientPaths.has(path)),
    }
    if (result.oma.status === "failed") {
      result.error = `OMA preparation failed: ${result.oma.message}`
      result.nextActions.push(rerunCommand(result, options))
      return result
    }
    if (availability.readiness !== "ready") {
      result.status = "action_required"
      result.exitCode = 2
      result.nextActions.push(rerunCommand(result, options))
      return result
    }
    result.status = "ready"
    result.exitCode = 0
    result.nextActions.push(
      `Run av order "your goal" from ${result.projectRoot}.`,
      "Restart/reload the agent client and complete its normal workspace/MCP trust steps if needed.",
    )
    return result
  } catch (error) {
    result.error =
      error instanceof Error
        ? error.message
        : "AV setup failed. Correct the reported settings and rerun av setup --yes."
    result.nextActions.push(result.error)
    return result
  }
}

export function printNoninteractiveSetupResult(result: NoninteractiveSetupResult, json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    return
  }
  const chief = result.chief.actorType
    ? `${result.chief.actorType} / ${result.chief.model ?? "native default"}`
    : "not selected"
  console.log(
    `AV setup: ${result.status}\nWorkspace: ${result.workspace ?? "not selected"}\nProject config: ${result.config.project}\nGlobal config: ${result.config.global}\nChief Director: ${chief} (${result.chief.readiness})\nOMA: ${result.oma.status}\nClient integrations: ${result.integrations.status}`,
  )
  for (const action of result.nextActions) console.log(`Next: ${action}`)
  if (result.error && !result.nextActions.includes(result.error)) console.log(`Error: ${result.error}`)
}
