import { describe, expect, it, vi } from "vitest"
import { type DiscoveryDeps, discoverAgents } from "../agent-discovery"
import { AGENT_BINARY, AGENT_INSTALL_HINT, AGENT_LOGIN_HINT } from "../doctor-checks"

const SECRET = "native-provider-fixture-secret"
type NativeActor = "dsh" | "zcode"
async function check(
  actor: NativeActor,
  files: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<DiscoveryDeps> = {},
) {
  const probe = vi.fn()
  const readFile = vi.fn((path: string) =>
    typeof files[path] === "string" ? files[path] : JSON.stringify(files[path]),
  )
  const values = await discoverAgents({
    home: "/home/test",
    env,
    resolveBinary: (name) => (name === actor ? `/bin/${actor}` : null),
    isExecutableFile: () => true,
    fileInfo: (path) => (Object.hasOwn(files, path) ? { isFile: true, size: 100 } : null),
    readFile,
    probe,
    ...overrides,
  })
  const result = values.find((value) => value.agentType === actor)
  if (!result) throw new Error("Expected native Actor discovery")
  expect(JSON.stringify(values)).not.toContain(SECRET)
  expect(probe).not.toHaveBeenCalled()
  return { result, readFile }
}

function zcodeConfig() {
  const provider = {
    providerId: "custom",
    config: {
      access: { type: "api-key", apiKey: SECRET },
      api: { type: "openai-chat-completions", baseUrl: "https://provider.invalid/v1" },
      personalModelIds: ["test-model"],
    },
  }
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [provider] as [typeof provider],
      },
      defaultModelSelection: { providerId: "custom", modelId: "test-model" },
    },
  }
}

describe("DSH and ZCode Actor discovery", () => {
  it.each(["dsh", "zcode"] as const)("registers executable metadata and actionable setup for %s", (actor) => {
    expect(AGENT_BINARY[actor]).toBe(actor)
    expect(AGENT_INSTALL_HINT[actor]).toContain(actor === "dsh" ? "@deepseek-ai/dsh" : "ZCode Agent CLI")
    expect(AGENT_LOGIN_HINT[actor]).toBeTruthy()
  })

  it("recognizes the DSH headless launch key and stable home dotenv credentials", async () => {
    expect((await check("dsh", {}, { DEEPSEEK_API_KEY: SECRET })).result.readiness).toBe("ready")
    expect(
      (await check("dsh", { "/home/test/.dsh/.env": `export DEEPSEEK_API_KEY='${SECRET}'\n` })).result.readiness,
    ).toBe("ready")
    expect(
      (await check("dsh", { "/custom/dsh/.env": `DEEPSEEK_API_KEY=${SECRET}` }, { DSH_HOME: "/custom/dsh" })).result
        .readiness,
    ).toBe("ready")
    expect(
      (await check("dsh", { "/home/test/profile/.env": `DEEPSEEK_API_KEY=${SECRET}` }, { DSH_HOME: "~/profile" }))
        .result.readiness,
    ).toBe("ready")
  })

  it("does not treat GUI credentials or other provider keys as DSH headless authentication", async () => {
    const { result, readFile } = await check(
      "dsh",
      { "/home/test/.dsh/.credentials.yaml": `DEEPSEEK_API_KEY: ${SECRET}` },
      { OPENAI_API_KEY: SECRET },
    )
    expect(result.readiness).toBe("unauthenticated")
    expect(result.reason).toContain("headless")
    expect(readFile).not.toHaveBeenCalled()
    expect(
      (await check("dsh", { "/home/test/.dsh/.env": `DEEPSEEK_API_KEY=${SECRET}` }, { DEEPSEEK_API_KEY: "" })).result
        .readiness,
    ).toBe("unauthenticated")
  })

  it("rejects unstable DSH profile overrides even when an API key exists", async () => {
    const { result } = await check("dsh", {}, { DSH_HOME: "relative", DEEPSEEK_API_KEY: SECRET })
    expect(result.readiness).toBe("unknown")
    expect(result.reason).toContain("absolute DSH_HOME")
  })

  it("recognizes selected ZCode personal API-provider configuration", async () => {
    expect(
      (await check("zcode", { "/home/test/.zcode/v2/provider_config.json": zcodeConfig() })).result.readiness,
    ).toBe("ready")
  })

  it.each(["/custom/data", "/home/test", "~"])(
    "resolves ZCODE_DATA_BASE_DIR %s as a parent directory",
    async (base) => {
      const prefix = base === "~" ? "/home/test" : base
      const { result } = await check(
        "zcode",
        { [`${prefix}/.zcode/v2/provider_config.json`]: zcodeConfig() },
        { ZCODE_DATA_BASE_DIR: base },
      )
      expect(result.readiness).toBe("ready")
    },
  )

  it("does not infer ZCode readiness from legacy API environment values or a directory", async () => {
    const { result } = await check(
      "zcode",
      {},
      { ZCODE_API_KEY: SECRET, ZCODE_MODEL: "test-model", OPENAI_API_KEY: SECRET },
    )
    expect(result.readiness).toBe("unknown")
    expect(result.reason).toContain("zcode login")
  })

  it.each([{}, { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/config/builtin.json" }])(
    "honors an absolute ZCode personal-provider override before the default profile file",
    async (builtinEnv) => {
      const { result, readFile } = await check(
        "zcode",
        {
          "/config/personal.json": zcodeConfig(),
          "/config/builtin.json": {},
          "/home/test/.zcode/v2/provider_config.json": { schemaVersion: 99 },
        },
        {
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/config/personal.json",
          ...builtinEnv,
        },
      )
      expect(result.readiness).toBe("ready")
      expect(readFile).not.toHaveBeenCalledWith("/home/test/.zcode/v2/provider_config.json")
    },
  )

  it.each([
    { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "relative.json" },
    { ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "relative.json" },
    {
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "relative.json",
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/config/builtin.json",
    },
  ])("keeps relative ZCode provider-file overrides actionable", async (env) => {
    const { result } = await check("zcode", { "/home/test/.zcode/v2/provider_config.json": zcodeConfig() }, env)
    expect(result.readiness).toBe("unknown")
    expect(result.reason).toContain("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE")
  })

  it("requires a matching ZCode default provider/model and an API key", async () => {
    const config = zcodeConfig()
    config.config.defaultModelSelection.modelId = "missing-model"
    expect((await check("zcode", { "/home/test/.zcode/v2/provider_config.json": config })).result.readiness).toBe(
      "unknown",
    )
    config.config.defaultModelSelection.modelId = "test-model"
    config.config.providerConfigRules.providerRules[0].config.access.apiKey = " "
    expect((await check("zcode", { "/home/test/.zcode/v2/provider_config.json": config })).result.readiness).toBe(
      "unauthenticated",
    )
  })

  it("keeps account-provider login unverified without a documented native auth-status signal", async () => {
    const config = zcodeConfig()
    config.config.providerConfigRules.providerRules[0].config.access.type = "account"
    const { result } = await check("zcode", { "/home/test/.zcode/v2/provider_config.json": config })
    expect(result.readiness).toBe("unknown")
    expect(result.reason).toContain("native login verification")
  })

  it.each(["dsh", "zcode"] as const)("bounds and redacts invalid %s native state", async (actor) => {
    const path = actor === "dsh" ? "/home/test/.dsh/.env" : "/home/test/.zcode/v2/provider_config.json"
    const { result, readFile } = await check(actor, {}, {}, { fileInfo: () => ({ isFile: true, size: 2_000_000 }) })
    expect(result.readiness).toBe("unknown")
    expect(readFile).not.toHaveBeenCalled()
    expect(
      (
        await check(
          actor,
          { [path]: SECRET },
          {},
          {
            readFile: () => {
              throw new Error(SECRET)
            },
          },
        )
      ).result.readiness,
    ).toBe("unknown")
  })
})
