import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverTools } from "../tool-discovery"

describe("tool discovery", () => {
  let root: string
  let home: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "av-tools-"))
    home = join(root, "home")
    await mkdir(home)
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const secret = "private-config-value-that-must-not-be-returned"

  it("finds executables without running them or claiming login", async () => {
    const bin = join(root, "bin")
    await mkdir(bin)
    for (const name of ["aws", "kubectl"]) {
      await writeFile(join(bin, name), "#!/bin/sh\nexit 99\n")
      await chmod(join(bin, name), 0o700)
    }
    await writeFile(join(bin, "docker"), "not executable")
    const tools = await discoverTools(root, { home, env: { PATH: bin, AWS_SECRET_ACCESS_KEY: secret } })
    expect(tools.find((tool) => tool.name === "aws")).toMatchObject({
      availability: "available",
      authentication: "unknown",
    })
    expect(tools.find((tool) => tool.name === "kubectl")).toMatchObject({
      availability: "available",
      authentication: "unknown",
    })
    expect(tools.find((tool) => tool.name === "docker")?.availability).toBe("unavailable")
    expect(JSON.stringify(tools)).not.toContain(secret)
  })

  it("reports configured MCP names and disabled servers without secrets", async () => {
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          aside: { command: secret, env: { TOKEN: secret }, args: [secret] },
          sentry: { url: `https://${secret}`, disabled: true },
        },
      }),
    )
    const tools = await discoverTools(root, { home, env: {} })
    expect(tools.find((tool) => tool.name === "aside")).toMatchObject({
      availability: "configured",
      scope: "project",
      authentication: "unknown",
    })
    expect(tools.find((tool) => tool.name === "sentry")?.availability).toBe("unavailable")
    expect(JSON.stringify(tools)).not.toContain(secret)
    expect(JSON.stringify(tools)).not.toContain("https://")
  })

  it("reads selected Codex home TOML metadata without leaking credentials", async () => {
    const codex = join(home, "selected-codex")
    await mkdir(codex)
    await writeFile(
      join(codex, "config.toml"),
      `[mcp_servers.analytics]\nurl = "https://${secret}"\n[mcp_servers.off]\nenabled = false\ncommand = "${secret}"\n`,
    )
    const tools = await discoverTools(root, { home, env: { CODEX_HOME: codex } })
    expect(tools.find((tool) => tool.name === "analytics")).toMatchObject({ availability: "configured", scope: "user" })
    expect(tools.find((tool) => tool.name === "off")?.availability).toBe("unavailable")
    expect(JSON.stringify(tools)).not.toContain(secret)
  })

  it("hides malformed source and rejects oversized files and symlinks", async () => {
    await writeFile(join(root, ".mcp.json"), `{${secret}`)
    await mkdir(join(root, ".cursor"))
    await writeFile(join(root, ".cursor/mcp.json"), secret.repeat(100_000))
    await mkdir(join(root, ".qwen"))
    await symlink(join(root, ".mcp.json"), join(root, ".qwen/settings.json"))
    const tools = await discoverTools(root, { home, env: {} })
    expect(tools.filter((tool) => tool.availability === "invalid")).toHaveLength(3)
    expect(JSON.stringify(tools)).not.toContain(secret)
  })

  it("reads Claude project entries but excludes unrelated projects", async () => {
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({
        projects: {
          [root]: { mcpServers: { clarity: { url: secret } } },
          "/other/project": { mcpServers: { unrelated: { command: secret } } },
        },
      }),
    )
    const tools = await discoverTools(root, { home, env: {} })
    expect(tools.find((tool) => tool.name === "clarity")?.availability).toBe("configured")
    expect(tools.some((tool) => tool.name === "unrelated")).toBe(false)
    expect(JSON.stringify(tools)).not.toContain(secret)
  })
})
