import { describe, expect, it } from "vitest"
import { MAX_JSON_RESPONSE_LENGTH, parseJson } from "./plan-validation"
import { parsePlan } from "./schemas"

describe("structured JSON response boundaries", () => {
  it("preserves a bare JSON object", () => {
    expect(parseJson('{"tasks":[]}', "Planning")).toEqual({ tasks: [] })
  })

  it("preserves a response containing only a JSON fence", () => {
    expect(parseJson('```json\n{"tasks":[]}\n```', "Planning")).toEqual({ tasks: [] })
  })

  it("extracts one fenced object surrounded by explanation and a closing note", () => {
    expect(parseJson('Here is the plan.\n```json\n{"tasks":[]}\n```\nReady for execution.', "Planning")).toEqual({
      tasks: [],
    })
  })

  it("extracts one unfenced object surrounded by prose", () => {
    expect(parseJson('Plan follows:\n{"tasks":[]}\nEnd of plan.', "Planning")).toEqual({ tasks: [] })
  })

  it("isolates a fenced payload from unmatched brackets in surrounding prose", () => {
    expect(parseJson('Placeholder {actor\n```json\n{"tasks":[]}\n```\nKeep [literal.', "Planning")).toEqual({
      tasks: [],
    })
  })

  it("does not salvage a valid inner fragment from a malformed fenced object", () => {
    expect(() => parseJson('```json\n{"broken":[} {"tasks":[]} }\n```', "Planning")).toThrow()
  })

  it("does not salvage a later fragment after an unfenced bracket mismatch", () => {
    expect(() => parseJson('Plan: {"broken":[} {"tasks":[]} }', "Planning")).toThrow()
  })

  it("rejects a separate JSON answer outside the fenced payload", () => {
    expect(() => parseJson('First: {"first":1}\n```json\n{"tasks":[]}\n```', "Planning")).toThrow()
  })

  it("accepts matching longer fences and Windows line endings", () => {
    expect(parseJson('Plan:\r\n````JSON\r\n{"tasks":[]}\r\n`````\r\nDone.', "Planning")).toEqual({ tasks: [] })
  })

  it("ignores braces, brackets and escaped quotes inside JSON strings", () => {
    const value = { note: 'Keep { braces } and [ brackets ]; quote: "yes", path: C:\\work' }
    expect(parseJson(`Explanation\n${JSON.stringify(value)}\nFinished.`, "Planning")).toEqual(value)
  })

  it("retains the outer object instead of treating its nested objects as separate answers", () => {
    const value = { tasks: [{ id: "one", metadata: { acceptance: ["nested"] } }], context: { depth: 2 } }
    expect(parseJson(`Plan:\n${JSON.stringify(value)}\nDone.`, "Planning")).toEqual(value)
  })

  it("preserves bare JSON arrays for callers to validate", () => {
    expect(parseJson('[{"id":"one"}]', "Planning")).toEqual([{ id: "one" }])
  })

  it("extracts one array without selecting its inner objects", () => {
    expect(parseJson('Results:\n[{"id":"one"},{"id":"two"}]\nDone.', "Planning")).toEqual([
      { id: "one" },
      { id: "two" },
    ])
  })

  it("leaves rejection of array-shaped plans to the strict plan schema", () => {
    expect(() => parsePlan('Plan:\n[{"tasks":[]}]\nDone.', [])).toThrow()
  })

  it.each([
    ['{"value":1,}', { value: 1 }],
    ['{"first":1 "second":2}', { first: 1, second: 2 }],
    ["{'value':'kept'}", { value: "kept" }],
    ['{value:"kept"}', { value: "kept" }],
    ['{"value":"undefined",}', { value: "undefined" }],
  ] as const)("repairs minor syntax in one complete bare, fenced or narrated object: %s", (source, value) => {
    for (const wrapped of [source, `\`\`\`json\n${source}\n\`\`\``, `Plan:\n${source}\nDone.`]) {
      expect(parseJson(wrapped, "Planning")).toEqual(value)
    }
  })

  it("preserves string contents while repairing surrounding syntax", () => {
    const value = { note: 'Keep { braces } and [ brackets ], ... and "quotes", path C:\\work' }
    const source = `${JSON.stringify(value).slice(0, -1)},}`
    expect(parseJson(source, "Planning")).toEqual(value)
  })

  it("keeps strict plan schema validation after repairing syntax", () => {
    expect(parseJson("{tasks:[],}", "Planning")).toEqual({ tasks: [] })
    expect(() => parsePlan("{tasks:[],}", [])).toThrow()
  })

  it.each([
    '{"tasks":[{"id":"one"}]',
    '{"note":"unfinished}',
    "{note:'unfinished}",
    '{"tasks":[}}',
    '{"tasks":[...]}',
    '{"value":}',
    '{"value":,"next":1}',
    '{"value":undefined}',
    '{"value":}\n{"valid":1}',
    "{first:1}\n{second:2}",
  ])("does not repair incomplete, mismatched, omitted or ambiguous content: %s", (source) => {
    expect(() => parseJson(source, "Planning")).toThrow()
    expect(() => parseJson(`\`\`\`json\n${source}\n\`\`\``, "Planning")).toThrow()
  })

  it("rejects a truncated JSON object", () => {
    expect(() => parseJson('Plan:\n{"tasks":[{"id":"one"}', "Planning")).toThrow()
  })

  it("rejects two distinct fenced JSON answers", () => {
    expect(() => parseJson('```json\n{"first":1}\n```\n```json\n{"second":2}\n```', "Planning")).toThrow()
  })

  it("rejects a valid fenced answer followed by an incomplete second JSON object", () => {
    expect(() => parseJson('```json\n{"value":1}\n```\n{"unfinished":', "Planning")).toThrow()
  })

  it("rejects two distinct unfenced JSON answers", () => {
    expect(() => parseJson('First: {"first":1}\nSecond: {"second":2}', "Planning")).toThrow()
  })

  it("accepts a valid JSON response exactly at the shared transport bound", () => {
    const overhead = JSON.stringify({ value: "" }).length
    const value = "x".repeat(MAX_JSON_RESPONSE_LENGTH - overhead)
    const source = JSON.stringify({ value })
    expect(source.length).toBe(MAX_JSON_RESPONSE_LENGTH)
    expect(parseJson(source, "Planning")).toEqual({ value })
  })

  it("enforces the bound on the whole response before extracting a small object", () => {
    const source = `${" ".repeat(MAX_JSON_RESPONSE_LENGTH)}{"tasks":[]}`
    expect(() => parseJson(source, "Planning")).toThrow("exceeds 128 KB")
  })

  it("preserves a caller's larger bounded response contract", () => {
    const value = { value: "x".repeat(MAX_JSON_RESPONSE_LENGTH) }
    expect(parseJson(JSON.stringify(value), "Decision", 256_000)).toEqual(value)
    expect(() => parseJson(JSON.stringify(value), "Planning")).toThrow("exceeds 128 KB")
  })

  it.each([MAX_JSON_RESPONSE_LENGTH, 256_000])("bounds both original and repaired text at %s characters", (limit) => {
    const overhead = '{value:""}'.length
    const source = `{value:"${"x".repeat(limit - overhead)}"}`
    expect(source.length).toBe(limit)
    expect(() => parseJson(source, "Planning", limit)).toThrow()
    expect(() => parseJson(`${source} `, "Planning", limit)).toThrow()
  })
})
