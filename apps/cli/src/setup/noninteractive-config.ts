import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, parse as parsePath, resolve } from "node:path"
import {
  type GlobalConfig,
  globalConfigSchema,
  type ProjectConfig,
  projectConfigSchema,
} from "@agent-valley/core/config/yaml-loader"
import { parse, stringify } from "yaml"
import type { z } from "zod"
import { type IntegrationFile, integrationFile } from "../client-integrations-files"
import { AGENT_TYPES } from "../doctor-checks"
import { canonicalConfig } from "./config-write"
import { currentRuntimeIdentity } from "./noninteractive-runtime"
import type { NoninteractiveSetupDependencies, NoninteractiveSetupResult, SetupOptions } from "./noninteractive-types"
import type { AgentType } from "./types"
import { validateOrderWorkspace } from "./workspace-step"

type ChiefSelection = NoninteractiveSetupResult["chief"]

export function validateNoninteractiveOptions(options: SetupOptions): void {
  if (!options.yes || options.edit || (options.mode !== undefined && options.mode !== "order"))
    throw new Error(
      "Use av setup --yes only for local order setup; --edit and --mode tracker require interactive setup.",
    )
  if (options.oma !== undefined && options.oma !== "prepare" && options.oma !== "skip")
    throw new Error("Use --oma prepare (default) or --oma skip for av setup --yes.")
  if (options.actor !== undefined && !AGENT_TYPES.includes(options.actor as AgentType))
    throw new Error(`actor.type: choose ${AGENT_TYPES.join(", ")}; rerun av setup --yes --actor <current-vendor>.`)
  if (
    options.model !== undefined &&
    (options.model.trim().length > 256 ||
      [...options.model].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
  )
    throw new Error(
      "actor.model: pass a single-line model ID up to 256 characters, or --model '' for the native default.",
    )
  if (options.workspace !== undefined && !options.workspace.trim())
    throw new Error(
      "workspace.root: pass --workspace /absolute/repository or omit it to use the saved workspace/current directory.",
    )
  if (options.verify !== undefined && !options.verify.trim())
    throw new Error(
      "verify.command: pass a nonempty trusted --verify command, or omit --verify for saved/Chief-designed checks.",
    )
}

async function configFile(
  path: string,
  schema: z.ZodType,
): Promise<{ file: IntegrationFile; raw: Record<string, unknown> }> {
  const file = await integrationFile(parsePath(path).root, path, "", 0o600)
  if (file.before === null) return { file, raw: {} }
  let raw: unknown
  try {
    raw = parse(file.before)
  } catch {
    throw new Error(
      `Invalid existing YAML at ${path}. Repair this file before rerunning av setup --yes; no replacement was made.`,
    )
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error(
      `Invalid existing configuration at ${path}: expected a YAML mapping. Repair this file before rerunning av setup --yes.`,
    )
  const checked = schema.safeParse(raw)
  if (!checked.success) {
    const keys = [...new Set(checked.error.issues.map((issue) => issue.path.join(".") || "<root>"))]
    throw new Error(
      `Invalid existing configuration at ${path} (${keys.join(", ")}). Correct these keys before rerunning av setup --yes; no replacement was made.`,
    )
  }
  return { file, raw: raw as Record<string, unknown> }
}

function actor(raw: Record<string, unknown>): NonNullable<GlobalConfig["actor"]> {
  return (raw.actor ?? raw.agent ?? {}) as NonNullable<GlobalConfig["actor"]>
}

function selectChief(
  options: SetupOptions,
  deps: NoninteractiveSetupDependencies,
  project: Record<string, unknown>,
  global: Record<string, unknown>,
): ChiefSelection {
  const runtime = options.actor === undefined ? currentRuntimeIdentity(deps.env) : undefined
  const projectActor = actor(project)
  const globalActor = actor(global)
  const selected = options.actor ?? runtime?.actorType ?? projectActor.type ?? globalActor.type
  if (!selected)
    throw new Error(
      `actor.type is missing in ${join(deps.projectRoot, "av.yaml")} and ${deps.globalConfigPath}, and the current agent runtime is unknown. Rerun av setup --yes --actor <current-vendor> --model <current-model-or-empty>.`,
    )
  const actorType = selected as AgentType
  const actorSource =
    options.actor !== undefined ? "explicit" : runtime ? "runtime" : projectActor.type ? "project" : "global"
  const previousType = projectActor.type ?? globalActor.type
  let model: string | null = null
  let modelSource: ChiefSelection["modelSource"] = "native-default"
  if (options.model !== undefined) {
    model = options.model.trim() || null
    modelSource = model ? "explicit" : "explicit-native-default"
  } else if (runtime) modelSource = "runtime-native-default"
  else if (previousType === actorType) {
    model = projectActor.model ?? (globalActor.type === actorType ? globalActor.model : undefined) ?? null
    if (model) modelSource = projectActor.model ? "project" : "global"
  }
  return {
    actorType,
    model,
    actorSource,
    modelSource,
    runtimeIdentity: runtime?.source ?? null,
    readiness: "not_checked",
    message: "Readiness has not been checked.",
  }
}

function updatedActor(raw: Record<string, unknown>, chief: ChiefSelection): Record<string, unknown> {
  const defaults = { ...actor(raw), type: chief.actorType }
  if (chief.model) defaults.model = chief.model
  else delete defaults.model
  return defaults
}

export async function prepareNoninteractiveConfig(options: SetupOptions, deps: NoninteractiveSetupDependencies) {
  validateNoninteractiveOptions(options)
  let projectRoot: string
  try {
    projectRoot = await realpath(resolve(deps.projectRoot))
    if (!(await lstat(projectRoot)).isDirectory()) throw new Error("not a directory")
  } catch {
    throw new Error(
      `AV configuration directory ${deps.projectRoot} does not exist. Run av setup from an existing directory.`,
    )
  }
  const globalPath = resolve(deps.globalConfigPath)
  const projectPath = join(projectRoot, "av.yaml")
  const project = await configFile(projectPath, projectConfigSchema)
  const global = await configFile(globalPath, globalConfigSchema)
  const chief = selectChief(options, { ...deps, projectRoot, globalConfigPath: globalPath }, project.raw, global.raw)
  for (const [raw, path] of [
    [project.raw, projectPath],
    [global.raw, globalPath],
  ] as const) {
    const defaults = actor(raw) as Record<string, unknown>
    if (defaults.type && defaults.type !== chief.actorType) {
      const stale = ["command", "args", "binary", "path"].find((key) => defaults[key] !== undefined)
      if (stale)
        throw new Error(
          `actor.${stale} in ${path} belongs to a different vendor. Reconcile this custom provider setting before rerunning av setup --yes --actor ${chief.actorType}.`,
        )
    }
  }
  const savedWorkspace = (project.raw.workspace as ProjectConfig["workspace"])?.root
  const selectedWorkspace = options.workspace ?? savedWorkspace ?? projectRoot
  const workspacePath = isAbsolute(selectedWorkspace) ? selectedWorkspace : resolve(projectRoot, selectedWorkspace)
  const workspaceError = await validateOrderWorkspace(workspacePath)
  if (workspaceError) throw new Error(workspaceError)
  const workspace = await realpath(workspacePath)
  const canonical = (raw: Record<string, unknown>) =>
    canonicalConfig({ ...raw, agent: raw.actor ?? raw.agent } as GlobalConfig)
  const savedProject = {
    ...canonical(project.raw),
    workspace: { ...(project.raw.workspace as ProjectConfig["workspace"]), root: workspace },
    actor: updatedActor(project.raw, chief),
    ...(options.verify !== undefined
      ? { verify: { ...(project.raw.verify as ProjectConfig["verify"]), command: options.verify.trim() } }
      : {}),
  }
  const savedGlobal = { ...canonical(global.raw), actor: updatedActor(global.raw, chief) }
  for (const [value, schema, path] of [
    [savedProject, projectConfigSchema, projectPath],
    [savedGlobal, globalConfigSchema, globalPath],
  ] as const) {
    if (!schema.safeParse(value).success)
      throw new Error(
        `Cannot save AV configuration at ${path}. Correct the supplied settings and rerun av setup --yes.`,
      )
  }
  project.file.after = stringify(savedProject, { lineWidth: 0 })
  global.file.after = stringify(savedGlobal, { lineWidth: 0 })
  project.file.writeMode = global.file.writeMode = 0o600
  return { projectRoot, workspace, projectPath, globalPath, chief, files: [project.file, global.file] }
}
