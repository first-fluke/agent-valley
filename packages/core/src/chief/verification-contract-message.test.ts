import { describe, expect, it } from "vitest"
import { goalVerificationContractSchema } from "./verification-contract"

const contract = (program: string, args: string[]) => ({
  version: 1,
  criteria: [{ criterion: "gates pass", checks: [{ kind: "command", program, args }] }],
})

describe("rejected verification commands", () => {
  it("names the rejected argv and explains bare bun test", () => {
    const result = goalVerificationContractSchema.safeParse(contract("bun", ["test"]))
    expect(result.success).toBe(false)
    const message = result.success ? "" : result.error.issues.map((issue) => issue.message).join(" ")
    expect(message).toContain("Rejected command: bun test.")
    expect(message).toContain("explicit test file paths")
    expect(message).toContain("Use explicit node/bun/Vitest tests")
  })

  it("names a rejected cargo argv and still accepts explicit bun test files", () => {
    const cargo = goalVerificationContractSchema.safeParse(contract("cargo", ["test", "-p", "arc-daemon"]))
    const message = cargo.success ? "" : cargo.error.issues.map((issue) => issue.message).join(" ")
    expect(message).toContain("Rejected command: cargo test -p arc-daemon.")
    expect(
      goalVerificationContractSchema.safeParse(contract("bun", ["test", "scripts/coverage/gate.test.ts"])).success,
    ).toBe(true)
  })

  it("accepts a leading ./ on test paths and empty content assertion lists", () => {
    const dotted = contract("bun", ["test", "./apps/desktop/tests/dashboard.test.tsx"])
    expect(goalVerificationContractSchema.safeParse(dotted).success).toBe(true)
    const emptyContains = {
      version: 1,
      criteria: [{ criterion: "report exists", checks: [{ kind: "file", path: "report.md", contains: [] }] }],
    }
    expect(goalVerificationContractSchema.safeParse(emptyContains).success).toBe(true)
    expect(goalVerificationContractSchema.safeParse(contract("bun", ["test", "../outside.test.ts"])).success).toBe(
      false,
    )
  })
})
