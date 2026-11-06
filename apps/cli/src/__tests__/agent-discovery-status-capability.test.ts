import { describe, expect, it, vi } from "vitest"
import { type DiscoveryDeps, discoverAgents } from "../agent-discovery"
import { AGENT_BINARY, type AgentType } from "../doctor-checks"

function discoveryFor(agent: AgentType, overrides: Partial<DiscoveryDeps> = {}) {
  return {
    home: "/fixture/home",
    env: {},
    now: () => 2_000_000_000_000,
    resolveBinary: (name: string) => (name === AGENT_BINARY[agent] ? `/fixture/bin/${name}` : null),
    isExecutableFile: () => true,
    fileInfo: () => null,
    readFile: () => "",
    probe: vi.fn(async () => ({ exitCode: 0, stdout: "Usage: CLI", stderr: "" })),
    ...overrides,
  } satisfies Partial<DiscoveryDeps>
}

describe("authentication status probe evidence", () => {
  it("marks Grok's unsupported status capability without probing a model or claiming authentication", async () => {
    const deps = discoveryFor("grok")
    const result = (await discoverAgents(deps)).find((entry) => entry.agentType === "grok")
    expect(result).toMatchObject({
      readiness: "unknown",
      binaryPath: "/fixture/bin/grok",
      authStatusProbe: "unsupported",
    })
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it("does not label an unsuccessful supported probe as unsupported", async () => {
    const deps = discoveryFor("codex", {
      probe: vi.fn(async () => {
        throw new Error("Mock supported status probe timeout")
      }),
    })
    const result = (await discoverAgents(deps)).find((entry) => entry.agentType === "codex")
    expect(result?.readiness).toBe("unknown")
    expect(result?.authStatusProbe).toBeUndefined()
    expect(deps.probe).toHaveBeenCalledOnce()
  })

  it("does not use unsupported status evidence when the Chief executable is missing", async () => {
    const result = (await discoverAgents(discoveryFor("grok", { resolveBinary: () => null }))).find(
      (entry) => entry.agentType === "grok",
    )
    expect(result?.readiness).toBe("unavailable")
    expect(result?.authStatusProbe).toBeUndefined()
    expect(result?.binaryPath).toBeUndefined()
  })
})
