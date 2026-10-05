import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, expect, it } from "vitest"
import { exportPluginPackages } from "../plugin-export"

let root: string | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

it("uses an exported plugin's project binding when the client launches from another repository", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "av-plugin-client-")))
  const project = join(root, "av-project")
  const repository = join(root, "target-repository")
  const clientDirectory = join(root, "other-repository")
  await Promise.all([project, repository, clientDirectory].map((path) => mkdir(path)))
  await writeFile(join(project, "av.yaml"), `workspace:\n  root: ${repository}\n`)
  const exported = await exportPluginPackages({ workspace: project, output: join(root, "plugins") })
  const config = JSON.parse(await readFile(join(exported.packages.portable, "mcp.json"), "utf8")) as {
    mcpServers: { av: { type: string; command: string; args: string[] } }
  }
  expect(config.mcpServers.av).toMatchObject({ type: "stdio", command: "av" })
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
  // Exercise the source CLI with the exact exported arguments, without building or changing client profiles.
  const transport = new StdioClientTransport({
    command: "bun",
    args: [entry, ...config.mcpServers.av.args],
    cwd: clientDirectory,
    stderr: "pipe",
  })
  client = new Client({ name: "av-plugin-test", version: "1" })
  await client.connect(transport)
  const listed = await client.callTool({ name: "av_missions", arguments: {} })
  expect(listed.structuredContent).toMatchObject({
    project,
    workspace: repository,
    executionContext: { managed: false, delegationAllowed: true },
  })
  const tools = await client.listTools()
  expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
    "av_cancel",
    "av_missions",
    "av_operation_cancel",
    "av_operation_report",
    "av_operation_resume",
    "av_operation_status",
    "av_operations",
    "av_order",
    "av_report",
    "av_resume",
    "av_status",
  ])
}, 10_000)
