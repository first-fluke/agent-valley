import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentConfig } from "./agent-session"
import { BaseSession, waitForExit } from "./base-session"
import * as sandbox from "./sandbox"

class EnvironmentSession extends BaseSession {
  async start(config: AgentConfig): Promise<void> {
    this.config = config
    await this.spawnSandboxed({
      agentType: config.type,
      command: config.type,
      args: [],
      stdio: ["ignore", "pipe", "pipe"],
    })
  }

  async execute(): Promise<void> {
    if (this.process) await waitForExit(this.process)
  }
}

let directory: string
let session: EnvironmentSession

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "av-sandbox-env-"))
  session = new EnvironmentSession()
})

afterEach(async () => {
  await session.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe("BaseSession sandbox environment composition", () => {
  it("plans with the same effective Codex environment passed to the child", async () => {
    vi.stubEnv("CODEX_HOME", join(directory, "unused-parent-profile"))
    vi.stubEnv("UNFORWARDED_HOST_SETTING", "host-only")
    const selectedProfile = join(directory, "selected-profile")
    const output = join(directory, "child-env.json")
    const planner = vi.spyOn(sandbox, "planSandboxedSpawn").mockResolvedValue({
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({CODEX_HOME:process.env.CODEX_HOME,UNFORWARDED_HOST_SETTING:process.env.UNFORWARDED_HOST_SETTING}))",
        output,
      ],
      sandboxed: false,
      platform: process.platform,
      networkAllowlist: [],
    })

    await session.start({
      type: "codex",
      workspacePath: directory,
      timeout: 5,
      env: { CODEX_HOME: selectedProfile },
    })
    await session.execute()

    const childEnvironment = JSON.parse(readFileSync(output, "utf8"))
    expect(childEnvironment).toEqual({ CODEX_HOME: selectedProfile })
    const plannedEnvironment = planner.mock.calls[0]?.[0].env
    expect(plannedEnvironment?.CODEX_HOME).toBe(childEnvironment.CODEX_HOME)
    expect(plannedEnvironment?.UNFORWARDED_HOST_SETTING).toBeUndefined()
  })
})
