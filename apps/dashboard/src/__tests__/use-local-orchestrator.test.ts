/**
 * useLocalOrchestrator regression tests.
 *
 * Validates that useLocalOrchestrator:
 * 1. Does NOT instantiate EventSource (the root cause of the leak)
 * 2. Uses pure derivation (useMemo) instead of side effects (useEffect)
 * 3. Accepts pre-fetched SSE data instead of a URL
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeAll, describe, expect, test } from "vitest"

describe("useLocalOrchestrator — no EventSource leak", () => {
  let source: string

  beforeAll(() => {
    const filePath = resolve(import.meta.dirname, "../features/team/hooks/use-local-orchestrator.ts")
    source = readFileSync(filePath, "utf-8")
  })

  test("does not instantiate EventSource", () => {
    expect(source).not.toContain("new EventSource")
  })

  test("does not import useEffect (no side effects)", () => {
    // useEffect was the old pattern that opened a new SSE connection
    expect(source).not.toContain("useEffect")
  })

  test("does not accept a URL parameter (no independent connection)", () => {
    // The old signature was useLocalOrchestrator(sseUrl: string)
    // The new signature takes (data, sseStatus) — no URL
    expect(source).not.toMatch(/sseUrl\s*:\s*string/)
  })

  test("uses useMemo for pure derivation", () => {
    expect(source).toContain("useMemo")
  })

  test("accepts OrchestratorState data as first parameter", () => {
    expect(source).toMatch(/data:\s*OrchestratorState\s*\|\s*null/)
  })

  test("accepts SSE status as second parameter", () => {
    expect(source).toMatch(/sseStatus:\s*SSEConnectionStatus/)
  })

  test("maps 'open' to 'connected'", () => {
    expect(source).toContain('"open"')
    expect(source).toContain('"connected"')
  })

  test("maps 'error' to 'error'", () => {
    expect(source).toContain('"error"')
  })
})
