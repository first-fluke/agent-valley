import { detectCycles } from "../domain/dag"
import type { DagNode } from "../domain/models"
import type { ChiefPlan, Persona } from "./types"

export const MAX_JSON_RESPONSE_LENGTH = 128_000

/** Find one complete JSON value without treating braces inside strings as boundaries. */
function embeddedJson(content: string): unknown {
  const brackets: string[] = []
  let start = -1
  let quoted = false
  let escaped = false
  let found = false
  let result: unknown
  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (start < 0) {
      if (character === "{" || character === "[") {
        start = index
        brackets.push(character)
      }
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === "{" || character === "[") brackets.push(character)
    else if (character === "}" || character === "]") {
      if (brackets.pop() !== (character === "}" ? "{" : "[")) {
        start = -1
        brackets.length = 0
        continue
      }
      if (brackets.length) continue
      const candidate = content.slice(start, index + 1)
      start = -1
      let value: unknown
      try {
        value = JSON.parse(candidate)
      } catch {
        continue
      }
      if (found) throw new Error("Multiple JSON values are ambiguous")
      result = value
      found = true
    }
  }
  if (!found || start >= 0) throw new Error("No unique complete JSON value")
  return result
}

export function parseJson(source: string, stage: string): unknown {
  if (source.length > MAX_JSON_RESPONSE_LENGTH)
    throw new Error(`${stage} response exceeds 128 KB. Return only the requested JSON.`)
  const content = source.trim()
  try {
    return JSON.parse(content)
  } catch {
    try {
      return embeddedJson(content)
    } catch {
      throw new Error(`${stage} response is not valid JSON. Return one JSON object matching the requested schema.`)
    }
  }
}

export function validatePlan(plan: ChiefPlan, personas: Persona[]): void {
  const ids = new Set<string>()
  const personaIds = new Set(personas.map((persona) => persona.id))
  for (const task of plan.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id ${task.id}. Give every plan task a unique id.`)
    ids.add(task.id)
    if (!personaIds.has(task.personaId))
      throw new Error(`Unknown Actor ${task.personaId}. Assign a configured Actor id.`)
  }
  const nodes: Record<string, DagNode> = Object.create(null)
  for (const task of plan.tasks) {
    for (const dependency of task.dependencies) {
      if (!ids.has(dependency))
        throw new Error(`Task ${task.id} depends on unknown task ${dependency}. Correct the plan.`)
    }
    if (new Set(task.dependencies).size !== task.dependencies.length)
      throw new Error(`Task ${task.id} repeats a dependency. Remove duplicate dependencies.`)
    nodes[task.id] = {
      issueId: task.id,
      identifier: task.id,
      status: "waiting",
      parentId: null,
      children: [],
      blockedBy: task.dependencies,
      blocks: [],
    }
  }
  if (detectCycles(nodes).length > 0)
    throw new Error("Chief Director plan contains a dependency cycle. Return an acyclic plan.")
}
