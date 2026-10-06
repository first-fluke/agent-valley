import { detectCycles } from "../domain/dag"
import type { DagNode } from "../domain/models"
import type { ChiefPlan, Persona } from "./types"

export function parseJson(source: string, stage: string): unknown {
  if (source.length > 128_000) throw new Error(`${stage} response exceeds 128 KB. Return only the requested JSON.`)
  const content = source.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")
  try {
    return JSON.parse(content)
  } catch {
    throw new Error(`${stage} response is not valid JSON. Return one JSON object matching the requested schema.`)
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
