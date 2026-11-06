import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { printNoninteractiveSetupResult, setupNoninteractive } from "../../setup/noninteractive"
import { noninteractiveFixture } from "./noninteractive-fixture"

let fixture: ReturnType<typeof noninteractiveFixture>
beforeEach(() => {
  fixture = noninteractiveFixture()
})
afterEach(() => {
  fixture.cleanup()
  vi.restoreAllMocks()
})

describe("setup authentication status capability", () => {
  it("completes local setup with unknown auth when the installed Chief has no supported status probe", async () => {
    fixture.deps.inspectActor.mockResolvedValue({
      agentType: "grok",
      binaryPath: "/fixture/bin/grok",
      readiness: "unknown",
      authStatusProbe: "unsupported",
      reason: "This CLI has no supported read-only authentication status probe.",
    })
    const result = await setupNoninteractive({ yes: true, actor: "grok", model: "", oma: "skip" }, fixture.deps)
    expect(result).toMatchObject({
      status: "ready",
      exitCode: 0,
      config: { saved: true },
      chief: { actorType: "grok", readiness: "unknown", authStatusProbe: "unsupported" },
      integrations: { status: "installed" },
    })
    expect(result.chief.message).toContain("authentication remains unverified")
    expect(result.nextActions.some((action) => /login|sign.in|setup --yes/i.test(action))).toBe(false)
    expect(fixture.deps.installActor).not.toHaveBeenCalled()
    expect(fixture.deps.inspectActor).toHaveBeenCalledOnce()
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    printNoninteractiveSetupResult(result)
    expect(log.mock.calls.flat().join("\n")).toContain("grok / native default (unknown; source: explicit)")
    expect(log.mock.calls.flat().join("\n")).toContain("authentication remains unverified")
  })

  it.each(["codex", "grok"] as const)("keeps generic %s unknown status blocking", async (actor) => {
    fixture.deps.inspectActor.mockResolvedValue({
      agentType: actor,
      binaryPath: `/fixture/bin/${actor}`,
      readiness: "unknown",
      reason: "Authentication check failed or timed out.",
    })
    const result = await setupNoninteractive({ yes: true, actor, oma: "skip" }, fixture.deps)
    expect(result).toMatchObject({
      status: "action_required",
      exitCode: 2,
      config: { saved: true },
      chief: { actorType: actor, readiness: "unknown" },
    })
    expect(result.nextActions.some((action) => action.includes("setup --yes"))).toBe(true)
  })

  it.each([
    { readiness: "unauthenticated" as const, binaryPath: "/fixture/bin/grok" },
    { readiness: "unknown" as const, binaryPath: undefined },
    { readiness: "unavailable" as const, binaryPath: "/fixture/bin/grok" },
  ])("does not waive $readiness without installed, unknown, unsupported evidence", async (state) => {
    fixture.deps.inspectActor.mockResolvedValue({
      agentType: "grok",
      ...state,
      authStatusProbe: "unsupported",
      reason: "Readiness is not confirmed.",
    })
    const result = await setupNoninteractive({ yes: true, actor: "grok", oma: "skip" }, fixture.deps)
    expect(result).toMatchObject({ status: "action_required", exitCode: 2, chief: { readiness: state.readiness } })
  })
})
