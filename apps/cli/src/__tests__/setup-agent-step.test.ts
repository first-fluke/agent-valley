import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { inspectChiefAgent, installChiefAgent, loginChiefAgent } from "../agent-provisioning"
import { stepAgentType } from "../setup/agent-step"
import { CANCEL, type SetupContext } from "../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { success: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))

vi.mock("../agent-provisioning", async (original) => ({
  ...(await original<typeof import("../agent-provisioning")>()),
  inspectChiefAgent: vi.fn(),
  installChiefAgent: vi.fn(),
  loginChiefAgent: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(p.select).mockReset().mockResolvedValue("codex")
  vi.mocked(p.text).mockReset().mockResolvedValue("")
  vi.mocked(inspectChiefAgent).mockReset().mockResolvedValue({
    agentType: "codex",
    binaryPath: "/fixture/codex",
    readiness: "ready",
    reason: "Fixture credentials found",
  })
  vi.mocked(installChiefAgent).mockReset().mockResolvedValue({ success: true, message: "Fixture install finished" })
  vi.mocked(loginChiefAgent).mockReset().mockResolvedValue({ success: true, message: "Fixture login finished" })
})

describe("Chief Director setup step", () => {
  it("asks only for Chief Director vendor/model when the selected CLI is already ready", async () => {
    const ctx: SetupContext = { agentType: "codex", agentModel: "test-chief-model" }
    vi.mocked(p.text).mockResolvedValue("test-chief-model")
    expect(await stepAgentType(ctx, 2, 2)).toBeUndefined()
    expect(p.select).toHaveBeenCalledOnce()
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "codex", message: expect.stringContaining("Chief Director vendor") }),
    )
    expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "test-chief-model" }))
    expect(ctx.agentType).toBe("codex")
    expect(ctx.agentModel).toBe("test-chief-model")
    expect(installChiefAgent).not.toHaveBeenCalled()
    expect(loginChiefAgent).not.toHaveBeenCalled()
  })

  it("trims explicit model IDs and clears old model selection on blank", async () => {
    const ctx: SetupContext = { agentType: "codex", agentModel: "previous" }
    vi.mocked(p.text).mockResolvedValueOnce("  selected/model  ").mockResolvedValueOnce("  ")
    await stepAgentType(ctx, 1, 1)
    expect(ctx.agentModel).toBe("selected/model")
    await stepAgentType(ctx, 1, 1)
    expect(ctx).not.toHaveProperty("agentModel")
  })

  it("does not prefill a model from a different Chief Director vendor", async () => {
    const ctx: SetupContext = { agentType: "claude", agentModel: "claude-model" }
    await stepAgentType(ctx, 1, 1)
    expect(p.text).toHaveBeenCalledWith(expect.objectContaining({ initialValue: undefined }))
    expect(ctx.agentType).toBe("codex")
    expect(ctx.agentModel).toBeUndefined()
  })

  it("preserves prior selections when vendor or model input is cancelled", async () => {
    const ctx: SetupContext = { agentType: "claude", agentModel: "previous" }
    vi.mocked(p.select).mockResolvedValueOnce(Symbol("cancel"))
    expect(await stepAgentType(ctx, 1, 1)).toBe(CANCEL)
    expect(p.text).not.toHaveBeenCalled()
    vi.mocked(p.select).mockResolvedValueOnce("codex")
    vi.mocked(p.text).mockResolvedValueOnce(Symbol("cancel") as Awaited<ReturnType<typeof p.text>>)
    expect(await stepAgentType(ctx, 1, 1)).toBe(CANCEL)
    expect(ctx).toEqual({ agentType: "claude", agentModel: "previous" })
    expect(inspectChiefAgent).not.toHaveBeenCalled()
  })

  it("installs only the chosen missing Chief Director and signs in before rechecking readiness", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("setup")
    vi.mocked(inspectChiefAgent)
      .mockResolvedValueOnce({ agentType: "codex", readiness: "unavailable", reason: "Install Codex" })
      .mockResolvedValueOnce({
        agentType: "codex",
        binaryPath: "/fixture/codex",
        readiness: "unauthenticated",
        reason: "Login required",
      })
    const ctx: SetupContext = {}
    await stepAgentType(ctx, 1, 1)
    expect(installChiefAgent).toHaveBeenCalledExactlyOnceWith("codex")
    expect(loginChiefAgent).toHaveBeenCalledExactlyOnceWith("codex")
    expect(inspectChiefAgent).toHaveBeenCalledTimes(3)
    expect(ctx.agentType).toBe("codex")
  })

  it("skips login when installer recheck already confirms authenticated credentials", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("setup")
    vi.mocked(inspectChiefAgent).mockResolvedValueOnce({
      agentType: "codex",
      readiness: "unavailable",
      reason: "Install Codex",
    })
    await stepAgentType({}, 1, 1)
    expect(installChiefAgent).toHaveBeenCalledOnce()
    expect(loginChiefAgent).not.toHaveBeenCalled()
  })

  it("keeps successful login separate from verified readiness and allows configure later", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("setup").mockResolvedValueOnce("later")
    vi.mocked(inspectChiefAgent).mockResolvedValue({
      agentType: "codex",
      binaryPath: "/fixture/codex",
      readiness: "unknown",
      reason: "Authentication unknown",
    })
    await stepAgentType({}, 1, 1)
    expect(loginChiefAgent).toHaveBeenCalledOnce()
    expect(p.log.success).not.toHaveBeenCalled()
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("not verified as ready"))
  })

  it("offers retry after failed installation and never starts login for a missing CLI", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("setup").mockResolvedValueOnce("later")
    vi.mocked(inspectChiefAgent).mockResolvedValue({
      agentType: "codex",
      readiness: "unavailable",
      reason: "Install Codex",
    })
    vi.mocked(installChiefAgent).mockResolvedValue({ success: false, message: "Installation timed out. Retry." })
    await stepAgentType({}, 1, 1)
    expect(loginChiefAgent).not.toHaveBeenCalled()
    expect(p.log.warn).toHaveBeenCalledWith("Installation timed out. Retry.")
    expect(p.select).toHaveBeenCalledTimes(3)
  })

  it("rechecks manual setup without installing or logging in", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("recheck")
    vi.mocked(inspectChiefAgent).mockResolvedValueOnce({
      agentType: "codex",
      binaryPath: "/fixture/codex",
      readiness: "unknown",
      reason: "Check login",
    })
    await stepAgentType({}, 1, 1)
    expect(inspectChiefAgent).toHaveBeenCalledTimes(2)
    expect(installChiefAgent).not.toHaveBeenCalled()
    expect(loginChiefAgent).not.toHaveBeenCalled()
  })

  it("cancels the wizard from the provisioning menu", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("codex").mockResolvedValueOnce("cancel")
    vi.mocked(inspectChiefAgent).mockResolvedValueOnce({
      agentType: "codex",
      readiness: "unavailable",
      reason: "Install Codex",
    })
    expect(await stepAgentType({}, 1, 1)).toBe(CANCEL)
    expect(installChiefAgent).not.toHaveBeenCalled()
  })
})
