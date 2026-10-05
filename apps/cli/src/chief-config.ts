import { isAbsolute, resolve } from "node:path"
import { DESIGN_DIRECTOR_ROLE } from "@agent-valley/core/chief/design-lead"
import { MARKETING_DIRECTOR_ROLE } from "@agent-valley/core/chief/marketing-lead"
import { CHIEF_DIRECTOR_ROLE } from "@agent-valley/core/chief/prompts"
import { actorSchema } from "@agent-valley/core/chief/schemas"
import { TECHNICAL_DIRECTOR_ROLE } from "@agent-valley/core/chief/technical-lead"
import type { Persona } from "@agent-valley/core/chief/types"
import {
  chiefCapturePolicy,
  chiefExecutionPolicy,
  chiefOperatingPolicy,
  mergeChiefConfig,
} from "@agent-valley/core/config/chief-schema"
import { readYamlFile } from "@agent-valley/core/config/yaml-file"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { type AgentAvailability, discoverAgents } from "./agent-discovery"
import { AGENT_TYPES } from "./doctor-checks"

export interface OrderOptions {
  once?: boolean
  workspace?: string
  verify?: string
  agent?: string
  actor?: string
  model?: string
  chief?: string
  director?: string
  personas?: string
  actors?: string
  timeout?: string
  repairs?: string
  rounds?: string
  oma?: boolean
  resume?: string
  retry?: boolean
  runs?: string
  duration?: string
  cost?: string
  accountRun?: string
  accountCost?: string
  parallel?: string
  resolveEffect?: string
  effectResult?: "completed" | "not-applied"
  worker?: boolean
  missionId?: string
  supervise?: boolean
  /** Internal accepted operation snapshot; never changes the configuration repository. */
  baselineWorkspace?: string
  operationId?: string
  /** Internal pin for the initiating Chief's explicit native model default. */
  nativeModel?: boolean
}

const agents = new Set<string>(AGENT_TYPES)

export function defaultPersonas(agentType: string, oma: boolean): Persona[] {
  const persona = (id: string, role: string, skill?: string): Persona => ({
    id,
    name:
      (
        {
          "chief-director": "Chief Director",
          "technical-director": "Technical Director",
          "design-director": "Design Director",
          "marketing-director": "Marketing Director",
        } as Record<string, string>
      )[id] ?? id,
    role,
    agentType,
    skills: oma && skill ? [skill] : [],
  })
  return [
    persona("chief-director", CHIEF_DIRECTOR_ROLE),
    persona("technical-director", TECHNICAL_DIRECTOR_ROLE),
    persona("design-director", DESIGN_DIRECTOR_ROLE),
    persona("marketing-director", MARKETING_DIRECTOR_ROLE),
    persona(
      "researcher",
      "Research primary sources and repository behavior. Write a cited report and separate evidence from assumptions.",
      "oma-search",
    ),
    persona(
      "engineer",
      "Implement changes using the repository's existing architecture and tests. Produce working files and evidence.",
    ),
    persona("backend", "Implement server APIs and application behavior, with regression tests.", "oma-backend"),
    persona(
      "frontend",
      "Implement user interfaces and verify interaction, accessibility and error states.",
      "oma-frontend",
    ),
    persona(
      "reviewer",
      "Independently inspect delivered changes and acceptance evidence. Report concrete blockers and never edit product files.",
      "oma-qa",
    ),
  ]
}

function integer(value: string | undefined, fallback: number, name: string, maximum: number, minimum = 1): number {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`)
  return parsed
}

export async function resolveOrderConfig(
  root: string,
  options: OrderOptions,
  discover: () => Promise<AgentAvailability[]> = discoverAgents,
) {
  const actorOption = options.actor ?? options.agent
  const profilePath = options.actors ?? options.personas
  const directorOption = options.director ?? options.chief
  const project = loadProjectConfig(root)
  const global = loadGlobalConfig()
  const chiefConfig = mergeChiefConfig(global?.chief, project?.chief)
  const workspace = options.workspace ?? project?.workspace?.root
  if (!workspace || !isAbsolute(workspace))
    throw new Error("Set --workspace to an absolute Git repository path, or set workspace.root in av.yaml.")
  const verifyCommand = options.verify ?? project?.verify?.command ?? ""
  if (actorOption !== undefined && !agents.has(actorOption))
    throw new Error(`Unknown actor ${actorOption}. Choose ${AGENT_TYPES.join(", ")}.`)
  const oma = options.oma === true
  const profile = profilePath ? readYamlFile(resolve(root, profilePath)) : null
  if (profilePath && !profile)
    throw new Error(`Actor file ${profilePath} is missing or empty. Add an actors array or omit --actors.`)
  const timeoutSec = integer(
    options.timeout,
    project?.agent?.timeout ?? global?.agent?.timeout ?? 600,
    "--timeout",
    86_400,
  )
  const maxRepairs = integer(options.repairs, 2, "--repairs", 10, 0)
  const maxRounds = integer(options.rounds, 8, "--rounds", 50)
  const model = options.model?.trim()
  if (options.model !== undefined && (!model || model.length > 256))
    throw new Error(
      "--model must be a nonempty model identifier up to 256 characters, supported by the Chief Director CLI.",
    )
  let availableAgents: string[] | undefined
  const availability = await discover()
  const readyActors = AGENT_TYPES.filter((type) =>
    availability.some((entry) => entry.agentType === type && entry.readiness === "ready"),
  )
  let personas: Persona[]
  if (profile) {
    personas = actorSchema
      .array()
      .min(2)
      .max(20)
      .parse(profile.actors ?? profile.personas)
  } else {
    const preferred = actorOption ?? project?.agent?.type ?? global?.agent?.type
    availableAgents = [...readyActors]
    if (preferred && !availableAgents.includes(preferred)) availableAgents.push(preferred)
    if (!availableAgents.length) {
      const details = availability.map((agent) => `${agent.agentType}: ${agent.reason}`).join("\n")
      throw new Error(
        `No installed, authenticated actor CLI was detected. Run av doctor, install and log in to an actor, then retry. If authentication cannot be detected, select your configured Chief Director CLI with --actor <type>.${details ? `\n${details}` : ""}`,
      )
    }
    const agent = availableAgents.find((type) => type === preferred) ?? availableAgents[0]
    if (!agent) throw new Error("Select an available actor CLI with --actor <type>.")
    personas = defaultPersonas(agent, false)
  }
  for (const persona of personas) {
    if (!agents.has(persona.agentType))
      throw new Error(`Actor ${persona.id} has unsupported actorType ${persona.agentType}.`)
  }
  if (new Set(personas.map((persona) => persona.id)).size !== personas.length)
    throw new Error("Duplicate actor IDs. Give each actor a unique id in the --actors file.")
  const chiefId =
    directorOption ??
    (typeof profile?.director === "string"
      ? profile.director
      : typeof profile?.chief === "string"
        ? profile.chief
        : personas.some((entry) => entry.id === "chief-director")
          ? "chief-director"
          : "chief")
  const chief = personas.find((persona) => persona.id === chiefId)
  if (!chief)
    throw new Error(`Chief Director actor ${chiefId} is not in the roster. Set --director to an existing actor ID.`)
  if (actorOption) chief.agentType = actorOption
  if (options.nativeModel) delete chief.model
  const configuredType = project?.agent?.type ?? global?.agent?.type
  const configuredModel =
    !options.nativeModel && !profile && configuredType === chief.agentType
      ? (project?.agent?.model ?? (global?.agent?.type === chief.agentType ? global.agent.model : undefined))
      : undefined
  if (model ?? configuredModel) chief.model = model ?? configuredModel
  const advisor = (kind: string, legacy: string, name: string, role: string): string => {
    const existing = personas.find((entry) => [kind, legacy].includes(entry.id) && entry.id !== chiefId)
    if (existing) return existing.id
    let id = kind
    let suffix = 1
    while (personas.some((entry) => entry.id === id)) id = `${kind}-${suffix++}`
    if (personas.length >= 20)
      throw new Error(
        `The team needs a ${name} distinct from the Chief Director. Add an actor with id ${kind} or leave a roster slot free (maximum 20 actors).`,
      )
    personas.push({ id, name, role, agentType: chief.agentType, skills: [] })
    return id
  }
  const technicalLeadId = advisor("technical-director", "cto", "Technical Director", TECHNICAL_DIRECTOR_ROLE)
  const designLeadId = advisor("design-director", "cdo", "Design Director", DESIGN_DIRECTOR_ROLE)
  const marketingLeadId = advisor("marketing-director", "cmo", "Marketing Director", MARKETING_DIRECTOR_ROLE)
  const executionPolicy = chiefExecutionPolicy(chiefConfig)
  if (options.runs) executionPolicy.maxRuns = integer(options.runs, executionPolicy.maxRuns, "--runs", 2_000)
  if (options.duration)
    executionPolicy.maxDurationSec = integer(options.duration, executionPolicy.maxDurationSec, "--duration", 604_800)
  if (options.parallel)
    executionPolicy.maxParallel = integer(options.parallel, executionPolicy.maxParallel, "--parallel", 8)
  if (options.cost !== undefined) {
    const cost = Number(options.cost)
    if (!Number.isFinite(cost) || cost <= 0)
      throw new Error("--cost must be a positive configured-price estimate in USD.")
    executionPolicy.maxEstimatedCostUsd = cost
  }
  return {
    workspace,
    verifyCommand,
    personas,
    ...(availableAgents ? { availableAgents } : {}),
    chiefId,
    technicalLeadId,
    designLeadId,
    marketingLeadId,
    oma,
    timeoutSec,
    maxRepairs,
    maxRounds,
    operatingPolicy: chiefOperatingPolicy(chiefConfig, readyActors, !profile),
    capturePolicy: chiefCapturePolicy(chiefConfig),
    executionPolicy,
    metricSourcePolicy: chiefConfig.metric_sources,
    containerObservationPolicy: chiefConfig.container_observation,
    toolEnvKeys: chiefConfig.tool_env_keys,
  }
}
