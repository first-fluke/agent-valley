import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectAsideBrowser, screenshotCode } from "./capture-mcp"
import { capturePolicySchema } from "./capture-schema"

const sdk = vi.hoisted(() => ({
  client: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
}))
vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    constructor(info: unknown) {
      sdk.client(info)
    }
    connect = sdk.connect
    listTools = sdk.listTools
    callTool = sdk.callTool
    close = sdk.close
  },
}))
vi.mock("../version", () => ({ AV_VERSION: "9.2.1-rc.4" }))
vi.mock("@modelcontextprotocol/client/stdio", () => ({
  StdioClientTransport: class {
    constructor(config: unknown) {
      sdk.transport(config)
    }
  },
}))

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jDZkAAAAASUVORK5CYII=",
  "base64",
)
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-capture-mcp-"))
  sdk.connect.mockResolvedValue(undefined)
  sdk.listTools.mockResolvedValue({ tools: [{ name: "repl" }] })
  sdk.close.mockResolvedValue(undefined)
  sdk.callTool.mockResolvedValue({
    content: [
      {
        type: "text",
        text: `AV_CAPTURE_RESULT:${JSON.stringify({ base64: png.toString("base64"), mimeType: "image/png" })}`,
      },
    ],
  })
})
afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("Aside MCP binding without spawning", () => {
  it("uses the configured stdio server, repl API and per-capture timeout, returning actual PNG bytes", async () => {
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { aside: { command: "/fixture/aside", args: ["mcp", "--fixture"], env: { FIXTURE: "1" } } },
      }),
    )
    const policy = capturePolicySchema.parse({ enabled: true, tabId: "wanted", timeoutMs: 9000 })
    const browser = await connectAsideBrowser(root, policy)
    expect(sdk.client).toHaveBeenCalledWith({ name: "agent-valley-capture", version: "9.2.1-rc.4" })
    expect(sdk.transport).toHaveBeenCalledWith({
      command: "/fixture/aside",
      args: ["mcp", "--fixture"],
      env: { FIXTURE: "1" },
      stderr: "ignore",
    })
    expect(await browser.screenshot()).toEqual(png)
    expect(sdk.callTool).toHaveBeenCalledWith(
      { name: "repl", arguments: { code: screenshotCode(policy), title: "AV mission capture" } },
      { timeout: 9000 },
    )
    await browser.close()
    expect(sdk.close).toHaveBeenCalledOnce()
  })
  it("uses aside mcp only when project config is absent and recognizes namespaced repl", async () => {
    sdk.listTools.mockResolvedValue({ tools: [{ name: "aside__repl" }] })
    const browser = await connectAsideBrowser(root, capturePolicySchema.parse({ tabId: "wanted" }))
    expect(sdk.transport).toHaveBeenCalledWith({ command: "aside", args: ["mcp"], stderr: "ignore" })
    await browser.screenshot()
    expect(sdk.callTool.mock.calls[0]?.[0].name).toBe("aside__repl")
    await browser.close()
  })
  it("rejects invalid project config before SDK transport and closes a connected unsupported server", async () => {
    await writeFile(join(root, ".mcp.json"), "not JSON")
    await expect(connectAsideBrowser(root, capturePolicySchema.parse({ tabId: "wanted" }))).rejects.toThrow(
      "valid mcpServers.aside",
    )
    expect(sdk.transport).not.toHaveBeenCalled()
    await rm(join(root, ".mcp.json"))
    sdk.listTools.mockResolvedValue({ tools: [{ name: "exec" }] })
    await expect(connectAsideBrowser(root, capturePolicySchema.parse({ tabId: "wanted" }))).rejects.toThrow(
      "must expose repl",
    )
    expect(sdk.close).toHaveBeenCalledOnce()
  })
  it.each([
    { isError: true, content: [] },
    { content: [{ type: "text", text: "No actual screenshot" }] },
    { content: [{ type: "text", text: 'AV_CAPTURE_RESULT:{"base64":"bm90IGEgcG5n","mimeType":"image/png"}' }] },
  ])("does not invent capture bytes when repl returns missing or invalid evidence", async (result) => {
    sdk.callTool.mockResolvedValue(result)
    const browser = await connectAsideBrowser(root, capturePolicySchema.parse({ tabId: "wanted" }))
    await expect(browser.screenshot()).rejects.toThrow()
    await browser.close()
  })
})

/** Evaluate generated code only against the documented Aside globals and fake pages. */
async function evaluate(policy: ReturnType<typeof capturePolicySchema.parse>, entries: unknown[]) {
  const page = { screenshot: vi.fn(async () => png) }
  const globals = {
    listBrowserTabs: vi.fn(async () => entries),
    getTabByTargetId: vi.fn(() => undefined),
    attachBrowserTab: vi.fn(async () => page),
    openTab: vi.fn(async () => page),
    console: { log: vi.fn() },
  }
  const script = new Function(...Object.keys(globals), `return async () => { ${screenshotCode(policy)} }`)
  await script(...Object.values(globals))()
  return { ...globals, page }
}
describe("documented Aside REPL screenshot contract", () => {
  it("lists and attaches the intended existing tab instead of assuming the neutral REPL page", async () => {
    const policy = capturePolicySchema.parse({ enabled: true, tabId: "wanted" })
    const result = await evaluate(policy, [
      { targetId: "unrelated", url: "https://other.test" },
      { targetId: "wanted", url: "https://wanted.test" },
    ])
    expect(result.attachBrowserTab).toHaveBeenCalledWith("wanted")
    expect(result.openTab).not.toHaveBeenCalled()
    expect(result.page.screenshot).toHaveBeenCalledWith({ type: "png", fullPage: false, timeout: policy.timeoutMs })
    expect(result.console.log.mock.calls[0]?.[0]).toContain("AV_CAPTURE_RESULT:")
  })
  it("opens only an explicitly bound URL when no matching open tab exists, preserving literal quoted URL text", async () => {
    const url = "https://fixture.test/?quoted=';console.log('untrusted')"
    const result = await evaluate(capturePolicySchema.parse({ enabled: true, targetUrl: url }), [])
    expect(result.openTab).toHaveBeenCalledWith(url)
    expect(result.console.log).toHaveBeenCalledOnce()
  })
  it("never navigates elsewhere when the configured specific tab is missing", async () => {
    await expect(
      evaluate(capturePolicySchema.parse({ enabled: true, tabId: "missing", targetUrl: "https://fixture.test" }), []),
    ).rejects.toThrow("Configured capture tab is unavailable")
  })
})
