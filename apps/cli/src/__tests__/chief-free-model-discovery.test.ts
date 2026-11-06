import { describe, expect, it, vi } from "vitest"
import {
  discoverFreeModels as discover,
  type FreeModelDiscoveryDeps,
  openCodeDefaultModel,
  parseOpenCodeCatalog,
} from "../chief-free-model-discovery"

const discoverFreeModels = (agent: string, path: string, deps: Partial<FreeModelDiscoveryDeps>) =>
  discover(agent, path, undefined, deps)

const SECRET = "never-return-provider-secret"

function model(id = "available-free", overrides: Record<string, unknown> = {}) {
  return {
    id,
    providerID: "opencode",
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
    headers: { authorization: SECRET },
    ...overrides,
  }
}

function catalog(...models: ReturnType<typeof model>[]): string {
  return models.map((entry) => `${entry.providerID}/${entry.id}\n${JSON.stringify(entry, null, 2)}\n`).join("")
}

function depsFor(before = catalog(model()), after = before, config: unknown = {}, state: unknown = {}) {
  const probe = vi.fn<FreeModelDiscoveryDeps["probe"]>(async (_binary, args) => ({
    exitCode: 0,
    stdout: args[0] === "debug" ? JSON.stringify(config) : args.includes("--refresh") ? after : before,
    stderr: "",
  }))
  return {
    env: { HOME: "/home/test", PATH: "/bin", OPENCODE_API_KEY: SECRET, UNRELATED_SECRET: SECRET } as NodeJS.ProcessEnv,
    resolveBinary: vi.fn<FreeModelDiscoveryDeps["resolveBinary"]>(() => "/bin/opencode"),
    probe,
    readState: vi.fn<FreeModelDiscoveryDeps["readState"]>(() => JSON.stringify(state)),
  }
}

describe("OpenCode native free-model catalog", () => {
  it("parses native pretty JSON, refresh notice and CRLF without returning private metadata", async () => {
    const output = `\u001b[32mModels cache refreshed\u001b[0m\n${catalog(model("a-free"), model("b-free"))}`
    const result = await discoverFreeModels("opencode", "/workspace", depsFor(output.replaceAll("\n", "\r\n")))
    expect(result).toEqual({ models: ["opencode/a-free", "opencode/b-free"] })
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it.each([
    ["paid input", { cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } }],
    ["paid output", { cost: { input: 0, output: 1, cache: { read: 0, write: 0 } } }],
    ["paid cache read", { cost: { input: 0, output: 0, cache: { read: 1, write: 0 } } }],
    ["paid cache write", { cost: { input: 0, output: 0, cache: { read: 0, write: 1 } } }],
    ["unknown prices", { cost: {} }],
    ["deprecated", { status: "deprecated" }],
    ["experimental", { status: "alpha" }],
    ["subscription provider", { providerID: "opencode-go" }],
    ["custom claimed-free provider", { providerID: "custom" }],
    ["no tools", { capabilities: { toolcall: false, input: { text: true }, output: { text: true } } }],
    ["no text input", { capabilities: { toolcall: true, input: { text: false }, output: { text: true } } }],
    ["no text output", { capabilities: { toolcall: true, input: { text: true }, output: { text: false } } }],
    [
      "paid tier",
      {
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          tiers: [{ input: 1, output: 0, cache: { read: 0, write: 0 } }],
        },
      },
    ],
    [
      "paid long context",
      {
        cost: {
          input: 0,
          output: 0,
          cache: { read: 0, write: 0 },
          experimentalOver200K: { input: 1, output: 0, cache: { read: 0, write: 0 } },
        },
      },
    ],
  ])("excludes %s while retaining another eligible model", async (_name, overrides) => {
    const deps = depsFor(catalog(model("eligible-free"), model("excluded", overrides)))
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({
      models: ["opencode/eligible-free"],
    })
  })

  it("accepts zero-price tiers and removes duplicate model identities", async () => {
    const candidate = model("free", {
      cost: {
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
        tiers: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      },
    })
    await expect(discoverFreeModels("opencode", "/workspace", depsFor(catalog(candidate, candidate)))).resolves.toEqual(
      {
        models: ["opencode/free"],
      },
    )
  })

  it.each([
    'opencode/model\n{\n  "id": "model"',
    'opencode/model\n{\n  "id": "other",\n  "providerID": "opencode"\n}',
    "arbitrary stdout\n{}",
    "opencode/model\n{\ninvalid\n}",
  ])("rejects malformed native output", (output) => {
    expect(() => parseOpenCodeCatalog(output)).toThrow()
  })
})

describe("OpenCode free-model metadata commands", () => {
  it("uses bounded native argv in the mission directory with native config and provider policies", async () => {
    const deps = depsFor()
    Object.assign(deps.env, {
      OPENCODE_CONFIG: "/settings/project.json",
      OPENCODE_CONFIG_CONTENT: '{"disabled_providers":["paid"]}',
      XDG_STATE_HOME: "/state",
    })
    await discoverFreeModels("opencode", "/workspace/project with spaces", deps)
    expect(deps.probe.mock.calls.map(([, args]) => args)).toEqual([
      ["models", "--verbose"],
      ["debug", "config"],
      ["models", "--verbose", "--refresh"],
    ])
    for (const [binary, args, options] of deps.probe.mock.calls) {
      expect(binary).toBe("/bin/opencode")
      expect(args).not.toContain("--pure")
      expect(options.cwd).toBe("/workspace/project with spaces")
      expect(options.timeoutMs).toBe(15_000)
      expect(options.maxOutputBytes).toBe(2_097_152)
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.env.OPENCODE_CONFIG).toBe("/settings/project.json")
      expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"disabled_providers":["paid"]}')
      expect(options.env.OPENCODE_API_KEY).toBe(SECRET)
      expect(options.env.UNRELATED_SECRET).toBeUndefined()
    }
    expect(deps.readState).toHaveBeenCalledWith("/state/opencode/model.json")
  })

  it.each(["1", "true"])("honors OPENCODE_DISABLE_FREE_MODELS=%s without starting native processes", async (value) => {
    const deps = depsFor()
    deps.env.OPENCODE_DISABLE_FREE_MODELS = value
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({ models: [] })
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it.each(["1", "true"])("honors OPENCODE_DISABLE_MODELS_FETCH=%s without forcing refresh", async (value) => {
    const deps = depsFor()
    deps.env.OPENCODE_DISABLE_MODELS_FETCH = value
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({
      models: ["opencode/available-free"],
    })
    expect(deps.probe).toHaveBeenCalledTimes(2)
  })

  it("returns no unsupported-vendor or missing-binary candidates", async () => {
    const deps = depsFor()
    await expect(discoverFreeModels("codex", "/workspace", deps)).resolves.toEqual({ models: [] })
    deps.resolveBinary.mockReturnValue(null)
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({ models: [] })
    expect(deps.probe).not.toHaveBeenCalled()
  })

  it("does not use stale free prices if refresh fails or exceeds the output limit", async () => {
    for (const failure of [
      new Error(SECRET),
      { exitCode: 1, stdout: SECRET, stderr: SECRET },
      { exitCode: 0, stdout: "x".repeat(2_097_153), stderr: "" },
    ]) {
      const deps = depsFor()
      deps.probe.mockImplementation(async (_binary, args) => {
        if (!args.includes("--refresh"))
          return { exitCode: 0, stdout: args[0] === "debug" ? "{}" : catalog(model()), stderr: "" }
        if (failure instanceof Error) throw failure
        return failure
      })
      await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({ models: [] })
    }
  })

  it("propagates parent cancellation during discovery and never starts refresh", async () => {
    const deps = depsFor()
    const controller = new AbortController()
    deps.probe.mockImplementation(
      (_binary, _args, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
        }),
    )
    const pending = discover("opencode", "/workspace", controller.signal, deps)
    controller.abort(new Error("mission interrupted"))
    await expect(pending).rejects.toThrow("mission interrupted")
    expect(deps.probe).toHaveBeenCalledTimes(2)
  })

  it("does not dispatch any native command when its parent is already cancelled", async () => {
    const deps = depsFor()
    const controller = new AbortController()
    controller.abort(new Error("mission interrupted"))
    await expect(discover("opencode", "/workspace", controller.signal, deps)).rejects.toThrow("mission interrupted")
    expect(deps.probe).not.toHaveBeenCalled()
  })
})

describe("OpenCode default attribution", () => {
  it("resolves the previous default before newly available recent models appear after refresh", async () => {
    const state = {
      recent: [
        { providerID: "opencode", modelID: "new-free" },
        { providerID: "opencode", modelID: "failed-free" },
      ],
    }
    const deps = depsFor(catalog(model("failed-free")), catalog(model("new-free"), model("failed-free")), {}, state)
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({
      models: ["opencode/new-free", "opencode/failed-free"],
      defaultModel: "opencode/failed-free",
    })
  })

  it("honors native default agent model before global config and recents", () => {
    const entries = parseOpenCodeCatalog(catalog(model("recent-free")))
    const state = { recent: [{ providerID: "opencode", modelID: "recent-free" }] }
    expect(
      openCodeDefaultModel(
        { default_agent: "custom", agent: { custom: { model: "opencode/agent-free" } }, model: "paid/global" },
        state,
        entries,
      ),
    ).toBe("opencode/agent-free")
    expect(openCodeDefaultModel({ agent: { build: { model: "opencode/build-free" } } }, state, entries)).toBe(
      "opencode/build-free",
    )
    expect(openCodeDefaultModel({ model: "paid/global" }, state, entries)).toBe("paid/global")
  })

  it("does not guess a model when recent state is unavailable or native selection uses internal priority", async () => {
    const deps = depsFor()
    deps.readState.mockImplementation(() => {
      throw new Error(SECRET)
    })
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({
      models: ["opencode/available-free"],
    })
    expect(openCodeDefaultModel({}, {}, parseOpenCodeCatalog(catalog(model())))).toBeUndefined()
    expect(openCodeDefaultModel({ model: SECRET }, {}, [])).toBeUndefined()
  })

  it("does not derive a default from refresh output when the pre-refresh catalog fails", async () => {
    const state = { recent: [{ providerID: "opencode", modelID: "new-free" }] }
    const deps = depsFor("malformed pre-refresh catalog", catalog(model("new-free")), {}, state)
    await expect(discoverFreeModels("opencode", "/workspace", deps)).resolves.toEqual({ models: ["opencode/new-free"] })
  })
})
