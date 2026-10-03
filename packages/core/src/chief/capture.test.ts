import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { capturePolicySchema, MissionCapture } from "./capture"
import { screenshotCode } from "./capture-mcp"

let root: string | undefined
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9ZkAAAAASUVORK5CYII=",
  "base64",
)
afterEach(async () => {
  vi.useRealTimers()
  if (root) await rm(root, { recursive: true, force: true })
})
describe("Aside mission capture artifacts", () => {
  it("requires an explicit browser target and quotes URL/tab inputs as data", () => {
    expect(() => capturePolicySchema.parse({ enabled: true })).toThrow("target_url")
    expect(() => capturePolicySchema.parse({ enabled: true, targetUrl: "file:///private" })).toThrow()
    const policy = capturePolicySchema.parse({ enabled: true, tabId: 'tab";console.log("oops")' })
    expect(screenshotCode(policy)).toContain(JSON.stringify({ id: policy.tabId }))
    expect(screenshotCode(policy)).not.toContain("attachActiveBrowserTab")
  })
  it("produces byte-backed private PNG/video attachments and timestamped stages", async () => {
    root = await mkdtemp(join(tmpdir(), "av-capture-"))
    vi.useFakeTimers()
    const close = vi.fn(async () => {})
    const encode = vi.fn(async (_directory: string, manifest: string, output: string) => {
      expect(await readFile(manifest, "utf8")).toContain("duration 0.5")
      await writeFile(output, Buffer.from("0000ftypisom-video-fixture"))
    })
    const capture = new MissionCapture(
      root,
      "mission",
      capturePolicySchema.parse({ enabled: true, tabId: "intended-tab", intervalMs: 500, maxFrames: 3 }),
      {
        connect: async () => ({ screenshot: async () => png, close }),
        encode,
      },
    )
    await capture.start()
    capture.label("work:task")
    await vi.advanceTimersByTimeAsync(500)
    const result = await capture.stop()
    expect(result.status).toBe("completed")
    expect(result.frames).toBe(3)
    expect(result.attachments.map((item) => item.mimeType)).toContain("video/mp4")
    for (const file of result.attachments) {
      const bytes = await readFile(file.path)
      expect(file.sizeBytes).toBe(bytes.length)
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
      expect((await stat(file.path)).mode & 0o777).toBe(0o600)
    }
    const manifest = JSON.parse(await readFile(join(capture.directory, "capture.json"), "utf8"))
    expect(manifest.frames[1].stage).toBe("work:task")
    expect(manifest.cadence).toContain("does not record audio")
    expect(close).toHaveBeenCalledOnce()
    expect(encode).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(result.frames).toBe(3)
  })
  it("retains real PNGs with a partial status when video encoding is unavailable", async () => {
    root = await mkdtemp(join(tmpdir(), "av-capture-"))
    const close = vi.fn(async () => {})
    const capture = new MissionCapture(
      root,
      "mission",
      capturePolicySchema.parse({ enabled: true, targetUrl: "http://localhost:3000", maxFrames: 1 }),
      {
        connect: async () => ({ screenshot: async () => png, close }),
        encode: async () => {
          throw new Error("ffmpeg unavailable")
        },
      },
    )
    await capture.start()
    const result = await capture.stop()
    expect(result.status).toBe("partial")
    expect(result.attachments.map((item) => item.mimeType)).toEqual(["image/png", "application/json"])
    expect(result.errors).toContain("ffmpeg unavailable")
    expect(close).toHaveBeenCalledOnce()
  })
  it("reports missing MCP and broken capture honestly without fabricated attachments", async () => {
    root = await mkdtemp(join(tmpdir(), "av-capture-"))
    const capture = new MissionCapture(root, "mission", capturePolicySchema.parse({ enabled: true, tabId: "tab" }), {
      connect: async () => {
        throw new Error("Aside unavailable")
      },
    })
    await capture.start()
    const result = await capture.stop()
    expect(result.status).toBe("failed")
    expect(result.attachments).toEqual([])
    expect(result.errors).toEqual(["Aside unavailable"])
  })
  it("returns capture failure when the artifact directory is unwritable without starting MCP", async () => {
    root = await mkdtemp(join(tmpdir(), "av-capture-"))
    await writeFile(join(root, ".agent-valley"), "not a directory")
    const connect = vi.fn(async () => ({ screenshot: async () => png, close: async () => {} }))
    const capture = new MissionCapture(root, "mission", capturePolicySchema.parse({ enabled: true, tabId: "tab" }), {
      connect,
    })
    await expect(capture.start()).resolves.toBeUndefined()
    const result = await capture.stop()
    expect(result.status).toBe("failed")
    expect(result.attachments).toEqual([])
    expect(result.errors.length).toBe(1)
    expect(connect).not.toHaveBeenCalled()
  })
  it("discloses frame-limit truncation instead of presenting the last image as later recorded activity", async () => {
    root = await mkdtemp(join(tmpdir(), "av-capture-"))
    vi.useFakeTimers()
    const screenshot = vi.fn(async () => png)
    const capture = new MissionCapture(
      root,
      "mission",
      capturePolicySchema.parse({ enabled: true, tabId: "tab", maxFrames: 1, video: false }),
      {
        connect: async () => ({ screenshot, close: async () => {} }),
      },
    )
    await capture.start()
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await capture.stop()
    expect(result.status).toBe("partial")
    expect(result.errors[0]).toContain("later activity was not recorded")
    expect(screenshot).toHaveBeenCalledOnce()
    const manifest = JSON.parse(await readFile(join(capture.directory, "capture.json"), "utf8"))
    expect(manifest.frameLimitReached).toBe(true)
    expect(Date.parse(manifest.capturedUntil)).toBeLessThan(Date.parse(manifest.finishedAt))
  })
})
