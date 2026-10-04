import { describe, expect, it } from "vitest"
import { qwenProfilePath } from "./qwen-profile"
import { DEFAULT_NETWORK_ALLOWLIST } from "./sandbox"
import { agentHomeAccess } from "./sandbox-agent-paths"

describe("Qwen native profile sandbox access", () => {
  it("includes documented Qwen provider endpoints in sandbox network metadata", () => {
    for (const host of [
      "dashscope.aliyuncs.com",
      "coding.dashscope.aliyuncs.com",
      "coding-intl.dashscope.aliyuncs.com",
      "token-plan.cn-beijing.maas.aliyuncs.com",
      "token-plan.ap-southeast-1.maas.aliyuncs.com",
    ])
      expect(DEFAULT_NETWORK_ALLOWLIST).toContain(host)
  })
  it("allows only Qwen's default profile and masks other vendors", () => {
    const access = agentHomeAccess("qwen", "/home/test", {})
    expect(access.active).toEqual(["/home/test/.qwen"])
    expect(access.inactive).not.toContain("/home/test/.qwen")
    expect(access.inactive).toContain("/home/test/.codex")
    expect(agentHomeAccess("codex", "/home/test", {}).inactive).toContain("/home/test/.qwen")
  })
  it("uses the configured absolute profile and masks the unused default", () => {
    const access = agentHomeAccess("qwen", "/home/test", { QWEN_HOME: "/custom/profile" })
    expect(access.active).toEqual(["/custom/profile"])
    expect(access.inactive).toContain("/home/test/.qwen")
  })
  it("expands native tilde syntax but cannot confirm relative paths across worktrees", () => {
    expect(qwenProfilePath("/home/test", { QWEN_HOME: "~" })).toBe("/home/test")
    expect(qwenProfilePath("/home/test", { QWEN_HOME: "~/custom" })).toBe("/home/test/custom")
    expect(qwenProfilePath("/home/test", { QWEN_HOME: "~\\custom" })).toBe("/home/test/custom")
    expect(qwenProfilePath("/home/test", { QWEN_HOME: "relative" })).toBeNull()
    expect(agentHomeAccess("qwen", "/home/test", { QWEN_HOME: "relative" }).active).toEqual([])
  })
})
