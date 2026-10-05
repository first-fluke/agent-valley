import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { mission as missionFixture } from "@agent-valley/core/chief/reports.fixture"
import { MissionStore } from "@agent-valley/core/chief/store"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, describe, expect, it } from "vitest"

let root: string | undefined
let client: Client | undefined
afterEach(async () => {
  await client?.close()
  if (root) await rm(root, { recursive: true, force: true })
})

describe("installed AV MCP command", () => {
  it("serves mission status and actual report through the CLI entry without starting an LLM", async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "av-client-cli-")))
    const target = join(root, "target-repository")
    await mkdir(target)
    await writeFile(join(root, "av.yaml"), `workspace:\n  root: ${target}\n`)
    const mission = missionFixture()
    mission.repositoryRoot = target
    mission.status = "waiting"
    await new MissionStore(join(root, ".agent-valley/missions")).save(mission)
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
    const transport = new StdioClientTransport({
      command: "bun",
      args: [entry, "mcp", "--workspace", root],
      stderr: "pipe",
    })
    let diagnostic = ""
    client = new Client({ name: "av-cli-test", version: "1" })
    await client.connect(transport)
    transport.stderr?.on("data", (chunk) => {
      diagnostic += String(chunk)
    })
    const catalog = await client.listTools()
    expect(catalog.tools.map((tool) => tool.name).sort()).toEqual([
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
    const result = await client.callTool({ name: "av_status", arguments: { missionId: mission.id } })
    expect(result.structuredContent).toMatchObject({ status: "waiting", verification: mission.verification })
    expect(result.structuredContent).toMatchObject({ repositoryRoot: target })
    const listed = await client.callTool({ name: "av_missions", arguments: {} })
    expect(listed.structuredContent).toMatchObject({ project: root, workspace: target })
    const report = await client.readResource({ uri: `av://missions/${mission.id}/report` })
    expect(report.contents[0]).toMatchObject({ mimeType: "text/markdown", text: expect.stringContaining("waiting") })
    const invalid = await client.callTool({ name: "av_order", arguments: { goal: "" } })
    expect(invalid.isError).toBe(true)
    await client.close()
    expect(diagnostic).toBe("")
  }, 10_000)
})
