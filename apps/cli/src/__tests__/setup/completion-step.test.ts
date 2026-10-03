import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { stepCompletion } from "../../setup/completion-step"
import { CANCEL, type SetupContext } from "../../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
}))
beforeEach(() => vi.resetAllMocks())

describe("setup completion requirements", () => {
  it("defaults standalone orders to Chief-designed checks without requesting a command", async () => {
    vi.mocked(p.select).mockResolvedValue("chief")
    const context: SetupContext = { trackerKind: "none", task: { kind: "code" } }
    await stepCompletion(context, 3, 3)
    expect(context).toEqual({ trackerKind: "none" })
    expect(p.text).not.toHaveBeenCalled()
    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "chief" }))
  })

  it("preserves an existing explicit order command as the initial selection and allows switching to Chief", async () => {
    vi.mocked(p.select).mockResolvedValue("chief")
    const context: SetupContext = { trackerKind: "none", verifyCommand: "test -s report.md", task: { kind: "code" } }
    await stepCompletion(context, 3, 3)
    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "code" }))
    expect(context).toEqual({ trackerKind: "none" })
    expect(p.text).not.toHaveBeenCalled()
  })

  it("keeps Chief-generated checks out of tracker completion choices", async () => {
    vi.mocked(p.select).mockResolvedValue("code")
    vi.mocked(p.text).mockResolvedValue("bun run test")
    await stepCompletion({ trackerKind: "github" }, 5, 5)
    const options = vi.mocked(p.select).mock.calls[0]?.[0].options
    expect(options?.map((option) => option.value)).toEqual(["code", "analysis"])
  })

  it("collects an existing verification command for code work", async () => {
    vi.mocked(p.select).mockResolvedValue("code")
    vi.mocked(p.text).mockResolvedValue(" bun run test ")
    const context: SetupContext = {}
    await stepCompletion(context, 5, 5)
    expect(context).toEqual({ task: { kind: "code" }, verifyCommand: "bun run test" })
    const validate = vi.mocked(p.text).mock.calls[0]?.[0].validate
    if (typeof validate !== "function") throw new Error("Expected a validation function")
    expect(validate(" ")).toContain("existing test")
    expect(validate("bun run test")).toBeUndefined()
  })

  it("collects a current-attempt report path and clears stale code verification", async () => {
    vi.mocked(p.select).mockResolvedValue("analysis")
    vi.mocked(p.text).mockResolvedValue("reports/{{attempt.id}}.md")
    const context: SetupContext = { verifyCommand: "old command" }
    await stepCompletion(context, 5, 5)
    expect(context.task).toEqual({ kind: "analysis", report_path: "reports/{{attempt.id}}.md" })
    expect(context.verifyCommand).toBeUndefined()
    const validate = vi.mocked(p.text).mock.calls[0]?.[0].validate
    if (typeof validate !== "function") throw new Error("Expected a validation function")
    expect(validate("report.md")).toContain("{{attempt.id}}")
    expect(validate("../{{attempt.id}}.md")).toContain("relative")
    expect(validate("/{{attempt.id}}.md")).toContain("relative")
    expect(validate("reports/{{attempt.id}}.md")).toBeUndefined()
  })

  it.each(["select", "text"])("cancels without saving when %s is cancelled", async (stage) => {
    vi.mocked(p.select).mockResolvedValue(stage === "select" ? Symbol("cancel") : "code")
    vi.mocked(p.text).mockResolvedValue(Symbol("cancel") as Awaited<ReturnType<typeof p.text>>)
    expect(await stepCompletion({}, 5, 5)).toBe(CANCEL)
  })
})
