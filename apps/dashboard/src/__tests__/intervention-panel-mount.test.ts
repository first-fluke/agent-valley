/**
 * InterventionPanel reachability + accessibility — source-inspection tests.
 *
 * Regression coverage for the "InterventionPanel is implemented but never
 * mounted" defect: `apps/dashboard/src/app/page.tsx` must import and render
 * both `ActiveAgentsPanel` (the selection affordance) and `InterventionPanel`
 * (the drawer), wiring them through shared `selectedAttempt` state.
 *
 * See active-agents-panel.test.ts for why this is source-inspection rather
 * than a render test (no jsdom in the dashboard vitest project yet).
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { beforeAll, describe, expect, test } from "vitest"

describe("InterventionPanel is mounted on the dashboard page", () => {
  let pageSource: string

  beforeAll(() => {
    const filePath = resolve(import.meta.dirname, "../app/page.tsx")
    pageSource = readFileSync(filePath, "utf-8")
  })

  test("imports InterventionPanel", () => {
    expect(pageSource).toMatch(/import\s*\{\s*InterventionPanel\s*\}\s*from\s*"@\/features\/orchestrator\/components\/intervention-panel"/)
  })

  test("imports ActiveAgentsPanel", () => {
    expect(pageSource).toMatch(/import\s*\{\s*ActiveAgentsPanel\s*\}\s*from\s*"@\/features\/orchestrator\/components\/active-agents-panel"/)
  })

  test("renders <InterventionPanel /> with the selected attempt and a close handler", () => {
    expect(pageSource).toMatch(/<InterventionPanel\s+attempt={selectedAttempt}\s+onClose={/)
  })

  test("renders <ActiveAgentsPanel /> wired to the same selection state", () => {
    expect(pageSource).toContain("<ActiveAgentsPanel")
    expect(pageSource).toContain("onSelect={setSelectedAttempt}")
  })

  test("does not override the default post implementation (uses the real /api/intervention fetch)", () => {
    expect(pageSource).not.toMatch(/InterventionPanel[\s\S]*?post={/)
  })

  test("does not hardcode an intervention auth token", () => {
    expect(pageSource.toLowerCase()).not.toContain("bearer ")
    expect(pageSource).not.toMatch(/SYMPHONY_INTERVENTION_TOKEN\s*[:=]\s*["'`]/)
  })

  test("clears the selection when the attempt's workspace drops out of live SSE state", () => {
    expect(pageSource).toMatch(/stillActive[\s\S]*setSelectedAttempt\(null\)/)
  })
})

describe("InterventionPanel accessibility (focus management + keyboard close)", () => {
  let panelSource: string

  beforeAll(() => {
    const filePath = resolve(
      import.meta.dirname,
      "../features/orchestrator/components/intervention-panel.tsx",
    )
    panelSource = readFileSync(filePath, "utf-8")
  })

  test("is a modal dialog", () => {
    expect(panelSource).toContain('role="dialog"')
    expect(panelSource).toContain('aria-modal="true"')
  })

  test("closes on Escape", () => {
    expect(panelSource).toMatch(/e\.key === "Escape"\) onClose\(\)/)
  })

  test("moves focus into the drawer on open and restores it on close", () => {
    expect(panelSource).toContain("closeButtonRef.current?.focus()")
    expect(panelSource).toContain("previouslyFocusedRef.current?.focus()")
  })

  test("traps Tab focus within the drawer", () => {
    expect(panelSource).toContain("onTrapKeyDown")
    expect(panelSource).toMatch(/e\.key !== "Tab"/)
  })

  test("does not hardcode an intervention auth token", () => {
    expect(panelSource.toLowerCase()).not.toMatch(/authorization["'`]?\s*:\s*["'`]bearer\s+\w/)
  })

  test("leaves a TODO(oma-deferred) marker instead of inventing a token auth flow", () => {
    expect(panelSource).toContain("TODO(oma-deferred)")
    expect(panelSource).toContain("SYMPHONY_INTERVENTION_TOKEN")
  })
})
