/**
 * ActiveAgentsPanel — source-inspection tests.
 *
 * The dashboard has no jsdom/@testing-library/react harness in v0.2 (see
 * vitest.config.ts coverage notes and use-local-orchestrator.test.ts for the
 * established pattern), so this suite validates the component's wiring and
 * accessibility contract by inspecting its source rather than rendering it.
 * Gap: once jsdom is added to the dashboard test project, this should be
 * replaced with a real render + interaction test (click a list item, assert
 * onSelect receives { attemptId, issueKey, agentType }).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeAll, describe, expect, test } from "vitest"

describe("ActiveAgentsPanel", () => {
  let source: string

  beforeAll(() => {
    const filePath = resolve(
      import.meta.dirname,
      "../features/orchestrator/components/active-agents-panel.tsx",
    )
    source = readFileSync(filePath, "utf-8")
  })

  test("is a client component", () => {
    expect(source).toContain('"use client"')
  })

  test("only lists workspaces that have a live attemptId", () => {
    expect(source).toMatch(/Boolean\(ws\.attemptId\)/)
  })

  test("renders nothing when there are no running workspaces", () => {
    expect(source).toMatch(/running\.length === 0\) return null/)
  })

  test("selecting an item calls onSelect with attemptId, issueKey, and agentType", () => {
    expect(source).toMatch(/onSelect\(\{[\s\S]*attemptId:\s*ws\.attemptId/)
    expect(source).toMatch(/issueKey:\s*ws\.key/)
    expect(source).toMatch(/agentType:\s*ws\.agentType/)
  })

  test("selection is a native button (keyboard-operable without extra handling)", () => {
    expect(source).toMatch(/<button[\s\S]*type="button"/)
  })

  test("marks the selected attempt via aria-pressed", () => {
    expect(source).toContain("aria-pressed={isSelected}")
  })

  test("advertises the dialog it opens via aria-haspopup", () => {
    expect(source).toContain('aria-haspopup="dialog"')
  })

  test("has a visible focus state on the selectable button", () => {
    expect(source).toContain("focus-visible:outline")
  })
})
