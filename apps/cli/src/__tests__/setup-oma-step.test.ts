import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { inspectOma, prepareOma } from "../oma-provisioning"
import { stepOma } from "../setup/oma-step"
import { BACK, CANCEL, type SetupContext } from "../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { success: vi.fn(), warn: vi.fn(), info: vi.fn() },
}))
vi.mock("../oma-provisioning", () => ({ inspectOma: vi.fn(), prepareOma: vi.fn() }))

const context: SetupContext = { workspaceRoot: "/selected/repository", agentType: "codex" }
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(p.select).mockResolvedValue("prepare")
  vi.mocked(inspectOma).mockResolvedValue({ success: false, message: "No OMA skills installed" })
  vi.mocked(prepareOma).mockResolvedValue({ success: true, message: "All latest OMA skills are ready" })
})

describe("OMA setup step", () => {
  it("defaults to preparing all latest skills in the selected repository", async () => {
    const ctx = { ...context }
    expect(await stepOma(ctx, 3, 4)).toBeUndefined()
    expect(inspectOma).toHaveBeenCalledExactlyOnceWith(context.workspaceRoot)
    expect(prepareOma).toHaveBeenCalledExactlyOnceWith(context.workspaceRoot)
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "prepare",
        options: expect.arrayContaining([expect.objectContaining({ value: "prepare", label: "Install OMA" })]),
      }),
    )
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining(context.workspaceRoot as string), "OMA skills")
    expect(p.log.success).toHaveBeenCalledWith("All latest OMA skills are ready")
    expect(ctx).toEqual(context)
  })

  it("offers an update even when OMA is already installed", async () => {
    vi.mocked(inspectOma).mockResolvedValue({ success: true, message: "Installed OMA skills detected" })
    await stepOma(context, 3, 4)
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: "prepare", label: "Update OMA" })]),
      }),
    )
    expect(prepareOma).toHaveBeenCalledOnce()
  })

  it("allows retry after failure and reports success only after verified preparation", async () => {
    vi.mocked(prepareOma).mockResolvedValueOnce({ success: false, message: "Preparation timed out" })
    await stepOma(context, 3, 4)
    expect(prepareOma).toHaveBeenCalledTimes(2)
    expect(p.log.warn).toHaveBeenCalledWith("Preparation timed out")
    expect(p.select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialValue: "prepare",
        options: expect.arrayContaining([expect.objectContaining({ value: "prepare", label: "Retry" })]),
      }),
    )
    expect(p.log.success).toHaveBeenCalledOnce()
  })

  it("allows explicit deferral with follow-up instructions and does not install", async () => {
    vi.mocked(p.select).mockResolvedValue("later")
    await stepOma(context, 3, 4)
    expect(prepareOma).not.toHaveBeenCalled()
    expect(p.log.success).not.toHaveBeenCalled()
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("av setup --edit"))
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining(context.workspaceRoot as string))
  })

  it("lets the user defer after a failed preparation without claiming readiness", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("prepare").mockResolvedValueOnce("later")
    vi.mocked(prepareOma).mockResolvedValue({ success: false, message: "Cannot prepare this workspace" })
    await stepOma(context, 3, 4)
    expect(prepareOma).toHaveBeenCalledOnce()
    expect(p.log.success).not.toHaveBeenCalled()
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("deferred"))
  })

  it.each(["cancel", Symbol("cancel")])("honors cancellation without installing: %s", async (choice) => {
    vi.mocked(p.select).mockResolvedValue(choice)
    expect(await stepOma(context, 3, 4)).toBe(CANCEL)
    expect(prepareOma).not.toHaveBeenCalled()
  })

  it("returns Back without installing", async () => {
    vi.mocked(p.select).mockResolvedValue("back")
    expect(await stepOma(context, 3, 4)).toBe(BACK)
    expect(prepareOma).not.toHaveBeenCalled()
  })

  it("returns Back when no workspace was selected without inspecting another directory", async () => {
    expect(await stepOma({}, 3, 4)).toBe(BACK)
    expect(inspectOma).not.toHaveBeenCalled()
    expect(prepareOma).not.toHaveBeenCalled()
    expect(p.select).not.toHaveBeenCalled()
  })
})
