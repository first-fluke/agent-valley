import { isAbsolute, resolve } from "node:path"
import { personaSchema } from "@agent-valley/core/chief/schemas"
import type { Persona } from "@agent-valley/core/chief/types"
import { readYamlFile } from "@agent-valley/core/config/yaml-file"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"

export interface OrderOptions {
  workspace?: string
  verify?: string
  agent?: string
  chief?: string
  personas?: string
  timeout?: string
  repairs?: string
  oma?: boolean
  resume?: string
}

const agents = new Set(["claude", "codex", "antigravity", "cursor", "grok", "kimi", "opencode"])

export function defaultPersonas(agentType: string, oma: boolean): Persona[] {
  const persona = (id: string, role: string, skill?: string): Persona => ({
    id,
    name: id,
    role,
    agentType,
    skills: oma && skill ? [skill] : [],
  })
  return [
    persona(
      "chief",
      "Own the complete goal: inspect the repository, plan work, assign specialists, review evidence and request repairs.",
    ),
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

export function resolveOrderConfig(root: string, options: OrderOptions) {
  const project = loadProjectConfig(root)
  const global = loadGlobalConfig()
  const workspace = options.workspace ?? project?.workspace?.root
  if (!workspace || !isAbsolute(workspace))
    throw new Error("Set --workspace to an absolute Git repository path, or set workspace.root in valley.yaml.")
  const verifyCommand = options.verify ?? project?.verify?.command
  if (!verifyCommand?.trim())
    throw new Error(
      "Set --verify to a real acceptance check, or set verify.command in valley.yaml. Research orders also need a check for their report artifact.",
    )
  const agent = options.agent ?? project?.agent?.type ?? global?.agent?.type ?? "claude"
  if (!agents.has(agent))
    throw new Error(`Unknown agent ${agent}. Choose claude, codex, antigravity, cursor, grok, kimi or opencode.`)
  const oma = options.oma === true
  const profile = options.personas ? readYamlFile(resolve(root, options.personas)) : null
  if (options.personas && !profile)
    throw new Error(`Persona file ${options.personas} is missing or empty. Add a personas array or omit --personas.`)
  const personas = profile ? personaSchema.array().min(2).max(20).parse(profile.personas) : defaultPersonas(agent, oma)
  for (const persona of personas) {
    if (!agents.has(persona.agentType))
      throw new Error(`Persona ${persona.id} has unsupported agentType ${persona.agentType}.`)
  }
  if (new Set(personas.map((persona) => persona.id)).size !== personas.length)
    throw new Error("Duplicate persona IDs. Give each persona a unique id in the --personas file.")
  const chiefId = options.chief ?? (typeof profile?.chief === "string" ? profile.chief : "chief")
  if (!personas.some((persona) => persona.id === chiefId))
    throw new Error(`Chief persona ${chiefId} is not in the roster. Set --chief to an existing persona ID.`)
  return {
    workspace,
    verifyCommand,
    personas,
    chiefId,
    oma,
    timeoutSec: integer(options.timeout, project?.agent?.timeout ?? global?.agent?.timeout ?? 600, "--timeout", 86_400),
    maxRepairs: integer(options.repairs, 2, "--repairs", 10, 0),
  }
}
