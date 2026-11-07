import { jsonrepair } from "jsonrepair"
import { detectCycles } from "../domain/dag"
import type { DagNode } from "../domain/models"
import type { ChiefPlan, Persona } from "./types"

export const MAX_JSON_RESPONSE_LENGTH = 128_000

class JsonRepairLimitError extends Error {}

function looksLikeJson(content: string, start: number): boolean {
  const next = content.slice(start + 1).trimStart()
  if (!next) return true
  const first = next[0] ?? ""
  if (content[start] === "{")
    return ["}", '"', "'", "“", "‘", "`", "/"].includes(first) || /^[A-Za-z_$][\w$-]*\s*:/.test(next)
  return (
    ["]", "{", "[", '"', "'", "“", "‘", "`", "/", "+", "-"].includes(first) ||
    /[0-9]/.test(first) ||
    /^(?:true|false|null|True|False|None)\b/.test(next)
  )
}

function parseCandidate(source: string, syntax: string, maxLength: number, repair: boolean): unknown {
  try {
    return JSON.parse(source)
  } catch (error) {
    if (!repair) throw error
  }
  // Repair punctuation, never omitted values or abbreviated collections.
  if (/\.\.\.|…|\bundefined\b|:\s*[,}\]]|,\s*,|\[\s*,|(?:\{|,)\s*(?:""|[\w$-]+)\s*\}/.test(syntax))
    throw new Error("JSON content is incomplete")
  const repaired = jsonrepair(source)
  if (repaired.length > maxLength)
    throw new JsonRepairLimitError(
      `Repaired JSON response exceeds ${maxLength / 1_000} KB. Return a smaller JSON response.`,
    )
  return JSON.parse(repaired)
}

/** Find one complete JSON value without treating braces inside strings as boundaries. */
function jsonCandidates(content: string, maxLength: number, repair: boolean) {
  const brackets: string[] = []
  let start = -1
  let quote: string | undefined
  let escaped = false
  let comment: "line" | "block" | undefined
  let syntax = ""
  let found = false
  let malformed = false
  let result: unknown
  let source: string | undefined
  for (let index = 0; index < content.length; index++) {
    const character = content[index]
    if (start < 0) {
      if ((character === "{" || character === "[") && looksLikeJson(content, index)) {
        start = index
        brackets.push(character)
        syntax = character
      }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (comment) {
      if (comment === "line" && character === "\n") comment = undefined
      else if (comment === "block" && character === "*" && content[index + 1] === "/") {
        comment = undefined
        index++
      }
      continue
    }
    if (character === "/" && (content[index + 1] === "/" || content[index + 1] === "*")) {
      comment = content[index + 1] === "/" ? "line" : "block"
      syntax += " "
      index++
      continue
    }
    if (character && ['"', "'", "“", "‘", "`"].includes(character)) {
      quote = character === "“" ? "”" : character === "‘" ? "’" : character
      syntax += '""'
      continue
    }
    syntax += character
    if (character === "{" || character === "[") brackets.push(character)
    else if (character === "}" || character === "]") {
      if (brackets.pop() !== (character === "}" ? "{" : "[")) {
        malformed = true
        start = -1
        brackets.length = 0
        continue
      }
      if (brackets.length) continue
      const candidate = content.slice(start, index + 1)
      start = -1
      const value = parseCandidate(candidate, syntax, maxLength, repair)
      if (found) return { count: 2, result, source, incomplete: false, malformed }
      result = value
      source = candidate
      found = true
    }
  }
  return { count: found ? 1 : 0, result, source, incomplete: start >= 0, malformed }
}

function embeddedJson(content: string, maxLength: number): unknown {
  let opening: { start: number; body: number; width: number } | undefined
  let fence: { start: number; body: number; bodyEnd: number; end: number } | undefined
  let offset = 0
  for (const line of content.split("\n")) {
    const delimiter = /^[ \t]*(`{3,})(json)?[ \t]*\r?$/i.exec(line)
    const width = delimiter?.[1]?.length
    if (opening) {
      if (width && !delimiter?.[2] && width >= opening.width) {
        if (fence) throw new Error("Multiple JSON fences are ambiguous")
        fence = { start: opening.start, body: opening.body, bodyEnd: offset, end: offset + line.length + 1 }
        opening = undefined
      }
    } else if (width) {
      opening = { start: offset, body: offset + line.length + 1, width }
    }
    offset += line.length + 1
  }
  if (opening) throw new Error("JSON fence is incomplete")
  if (fence) {
    // An explicit payload must validate as a whole; never salvage a fragment of it.
    const body = content.slice(fence.body, fence.bodyEnd).trim()
    const candidate = jsonCandidates(body, maxLength, true)
    if (candidate.count !== 1 || candidate.incomplete || candidate.malformed || candidate.source !== body)
      throw new Error("No unique complete JSON value")
    const outside = `${content.slice(0, fence.start)}\n${content.slice(fence.end)}`
    const other = jsonCandidates(outside, maxLength, false)
    if (other.count || other.incomplete || other.malformed) throw new Error("Multiple JSON values are ambiguous")
    return candidate.result
  }
  const candidate = jsonCandidates(content, maxLength, true)
  if (candidate.count !== 1 || candidate.incomplete || candidate.malformed)
    throw new Error("No unique complete JSON value")
  return candidate.result
}

export function parseJson(source: string, stage: string, maxLength = MAX_JSON_RESPONSE_LENGTH): unknown {
  if (source.length > maxLength)
    throw new Error(`${stage} response exceeds ${maxLength / 1_000} KB. Return only the requested JSON.`)
  const content = source.trim()
  try {
    return JSON.parse(content)
  } catch {
    try {
      return embeddedJson(content, maxLength)
    } catch (error) {
      if (error instanceof JsonRepairLimitError) throw error
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
