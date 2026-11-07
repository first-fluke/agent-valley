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

  it("does not repair invalid JSON syntax", () => {
    expect(() => parseJson('Plan:\n{"tasks":[],}\nDone.', "Planning")).toThrow()
  })

  it("rejects a truncated JSON object", () => {
    expect(() => parseJson('Plan:\n{"tasks":[{"id":"one"}', "Planning")).toThrow()
  })

  it("rejects two distinct fenced JSON answers", () => {
    expect(() => parseJson('```json\n{"first":1}\n```\n```json\n{"second":2}\n```', "Planning")).toThrow()
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
})
