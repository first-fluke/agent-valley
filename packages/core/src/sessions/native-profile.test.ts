import { describe, expect, it } from "vitest"
import { agentEnvKeys, capabilitiesFor } from "../agent-registry"
import { buildAgentEnv } from "./base-session"
import { nativeProfilePath } from "./native-profile"
import { DEFAULT_NETWORK_ALLOWLIST } from "./sandbox"
import { agentHomeAccess } from "./sandbox-agent-paths"

describe("native Actor profile and credential isolation", () => {
  const home = "/home/test"

  it("allows DSH's selected home and masks unused vendor profiles", () => {
    expect(agentHomeAccess("dsh", home).active).toEqual(["/home/test/.dsh"])
    const access = agentHomeAccess("dsh", home, { DSH_HOME: "/custom/dsh" })
    expect(access.active).toEqual(["/custom/dsh"])
    expect(access.inactive).toContain("/home/test/.dsh")
    expect(access.inactive).toContain("/home/test/.zcode")
    expect(access.inactive).toContain("/home/test/.qwen")
  })

  it("treats ZCODE_DATA_BASE_DIR as the parent and preserves native CLI resources", () => {
    expect(agentHomeAccess("zcode", home).active).toEqual(["/home/test/.zcode"])
    expect(agentHomeAccess("zcode", home, { ZCODE_DATA_BASE_DIR: "/custom" }).active).toEqual([
      "/custom/.zcode",
      "/home/test/.zcode",
    ])
    for (const base of [home, "~"])
      expect(nativeProfilePath(home, { ZCODE_DATA_BASE_DIR: base }, "ZCODE_DATA_BASE_DIR", ".zcode", ".zcode")).toBe(
        "/home/test/.zcode",
      )
  })

  it.each(["relative", "~", home, "/home", "/"])("rejects an unsafe DSH profile %j", (profile) => {
    expect(nativeProfilePath(home, { DSH_HOME: profile }, "DSH_HOME", ".dsh")).toBeNull()
    expect(agentHomeAccess("dsh", home, { DSH_HOME: profile }).active).toEqual([])
  })

  it("does not grant invalid ZCode parent paths or expose other Actors' homes", () => {
    expect(agentHomeAccess("zcode", home, { ZCODE_DATA_BASE_DIR: "relative" }).active).toEqual([])
    expect(agentHomeAccess("claude", home).inactive).toEqual(expect.arrayContaining([`${home}/.dsh`, `${home}/.zcode`]))
  })

  it("allows native provider-config lock/rename in a dedicated override directory", () => {
    expect(
      agentHomeAccess("zcode", home, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/provider/config.json" }).active,
    ).toEqual(["/home/test/.zcode", "/custom/provider"])
    // A loose file in HOME must not turn into a write grant for the entire home directory.
    expect(
      agentHomeAccess("zcode", home, { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: `${home}/provider.json` }).active,
    ).toEqual(["/home/test/.zcode"])
  })

  it("forwards only native keys for the chosen Actor", () => {
    const env = {
      DEEPSEEK_API_KEY: "test-only-deepseek",
      DSH_HOME: "/custom/dsh",
      ZCODE_DATA_BASE_DIR: "/custom/zcode-parent",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/provider.json",
      ZCODE_CREDENTIAL_SECRET: "test-only-cipher-key",
      UNRELATED_SECRET: "must-not-forward",
    }
    expect(buildAgentEnv("dsh", {}, env)).toMatchObject({
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
      DSH_HOME: env.DSH_HOME,
    })
    expect(buildAgentEnv("dsh", {}, env)).not.toHaveProperty("ZCODE_DATA_BASE_DIR")
    expect(buildAgentEnv("zcode", {}, env)).toMatchObject({
      ZCODE_DATA_BASE_DIR: env.ZCODE_DATA_BASE_DIR,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE,
      ZCODE_CREDENTIAL_SECRET: env.ZCODE_CREDENTIAL_SECRET,
    })
    expect(buildAgentEnv("zcode", {}, env)).not.toHaveProperty("DEEPSEEK_API_KEY")
    expect(buildAgentEnv("zcode", {}, env)).not.toHaveProperty("UNRELATED_SECRET")
    expect(agentEnvKeys("qwen")).toContain("QWENCLOUD_API_KEY")
    expect(capabilitiesFor("dsh")).toEqual(["abort"])
    expect(capabilitiesFor("zcode")).toEqual(["abort"])
  })

  it("includes native API and QwenCloud hosts in sandbox network metadata", () => {
    for (const host of [
      "chat.qwen.ai",
      "maas.qianwenaiapi.com",
      "token-plan.maas.qianwenaiapi.com",
      "maas.qwencloudapi.com",
      "token-plan.maas.qwencloudapi.com",
      "api.deepseek.com",
      "api.z.ai",
      "open.bigmodel.cn",
    ])
      expect(DEFAULT_NETWORK_ALLOWLIST).toContain(host)
  })
})
