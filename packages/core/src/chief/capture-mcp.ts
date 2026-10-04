import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { z } from "zod"
import { AV_VERSION } from "../version"
import type { CapturePolicy } from "./capture-schema"

export interface CaptureBrowser {
  screenshot(): Promise<Buffer>
  close(): Promise<void>
}
const serverSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
})
const prefix = "AV_CAPTURE_RESULT:"
export function screenshotCode(policy: CapturePolicy): string {
  const target = JSON.stringify({ url: policy.targetUrl, id: policy.tabId })
  return `await (async () => {
const target = ${target};
const entries = await listBrowserTabs();
const intended = target.id ? entries.find(t => String(t.targetId ?? t.id) === target.id) : entries.find(t => t.url === target.url);
if (!intended && target.id) throw new Error("Configured capture tab is unavailable. Set chief.capture.tab_id to an open tab.");
const selected = intended ? (getTabByTargetId(intended.targetId ?? intended.id) ?? await attachBrowserTab(intended.targetId ?? intended.id)) : await openTab(target.url);
if (!selected || !selected.screenshot) throw new Error("Aside did not return a browser page for the configured target.");
const bytes = await selected.screenshot({type: "png", fullPage: false, timeout: ${policy.timeoutMs}});
console.log(${JSON.stringify(prefix)} + JSON.stringify({base64: bytes.toString("base64"), mimeType: "image/png"}));
})();`
}
export async function connectAsideBrowser(repository: string, policy: CapturePolicy): Promise<CaptureBrowser> {
  let config: z.infer<typeof serverSchema> = { command: "aside", args: ["mcp"] }
  try {
    const raw = JSON.parse(await readFile(join(repository, ".mcp.json"), "utf8"))
    if (raw.mcpServers?.aside) config = serverSchema.parse(raw.mcpServers.aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        "Read a valid mcpServers.aside stdio configuration from .mcp.json, or remove it to use aside mcp.",
      )
  }
  const client = new Client({ name: "agent-valley-capture", version: AV_VERSION })
  const transport = new StdioClientTransport({ ...config, stderr: "ignore" })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const repl = listed.tools.find((tool) => tool.name === "repl" || tool.name.endsWith("__repl"))
    if (!repl)
      throw new Error("Aside MCP must expose repl with browser screenshot support. Update Aside and retry capture.")
    return {
      async screenshot() {
        const result = await client.callTool(
          { name: repl.name, arguments: { code: screenshotCode(policy), title: "AV mission capture" } },
          { timeout: policy.timeoutMs },
        )
        if (result.isError)
          throw new Error("Aside screenshot failed. Check the configured browser target and Aside permissions.")
        const blocks = result.content as Array<{ type: string; text?: string }>
        const line = blocks.flatMap((block) => (block.text ?? "").split("\n")).find((item) => item.startsWith(prefix))
        if (!line) throw new Error("Aside returned no screenshot bytes. Check repl screenshot support.")
        const parsed = z
          .strictObject({ base64: z.string().min(1).max(28_000_000), mimeType: z.literal("image/png") })
          .parse(JSON.parse(line.slice(prefix.length)))
        const bytes = Buffer.from(parsed.base64, "base64")
        if (
          bytes.length > 20 * 1024 * 1024 ||
          !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        )
          throw new Error("Aside must return PNG screenshot bytes of at most 20 MB.")
        return bytes
      },
      close: () => client.close(),
    }
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}
