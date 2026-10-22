import { describe, expect, test } from "vitest"
import { buildDarwinSandboxCommand } from "./sandbox-darwin"

const BASE_REQUEST = {
  agentType: "claude",
  command: "claude",
  args: ["--print", "--dangerously-skip-permissions"],
  workspacePath: "/workspaces/ACR-42",
}

describe("buildDarwinSandboxCommand", () => {
  test("limits CFPreferences shared-memory reads to Codex", () => {
    for (const agentType of ["codex", "claude", "qwen", "custom"]) {
      const { args } = buildDarwinSandboxCommand({ ...BASE_REQUEST, agentType, networkAllowlist: [] })
      const profile = args[1] as string
      expect(profile.split("\n").filter((line) => line.includes("ipc-posix"))).toEqual(
        agentType === "codex" ? ['(allow ipc-posix-shm-read* (ipc-posix-name-prefix "apple.cfprefs."))'] : [],
      )
      expect(profile).toContain("(deny default)")
      expect(profile).toContain("(deny file-write*)")
    }
  })
})
