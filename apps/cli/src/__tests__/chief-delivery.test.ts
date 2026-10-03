import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  listReportDeliveries,
  type ReportDeliveryPolicy,
  retryPendingReports,
} from "@agent-valley/core/chief/report-delivery"
import { mission as reportMission } from "@agent-valley/core/chief/reports.fixture"
import type { Mission } from "@agent-valley/core/chief/types"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { saveAndDeliverMissionReport } from "../chief-delivery"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({ loadGlobalConfig: vi.fn(), loadProjectConfig: vi.fn() }))

let root: string
let repository: string
let value: Mission
let policy: ReportDeliveryPolicy
const hook = "https://hooks.example.test/synthetic-report-secret"

function configure(reporting: ReportDeliveryPolicy | undefined = policy): void {
  vi.mocked(loadGlobalConfig).mockReturnValue(null)
  vi.mocked(loadProjectConfig).mockReturnValue({
    workspace: { root: repository },
    chief: { reporting },
  } as NonNullable<ReturnType<typeof loadProjectConfig>>)
}
function response() {
  return new Response(JSON.stringify({ id: "confirmed-native-message", ok: true }), { status: 200 })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-cli-delivery-"))
  repository = join(root, "source-repository")
  await mkdir(repository)
  value = { ...reportMission(), repositoryRoot: repository }
  policy = { destinations: [{ id: "operator", channel: "webhook", url_env: "CLI_REPORT_URL" }], max_attempts: 1 }
  configure()
  vi.stubEnv("CLI_REPORT_URL", hook)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () => response()),
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("CLI report and native attachment delivery", () => {
  it("sends actual Markdown report, PNG and MP4 bytes and keeps the outbox in the source repository", async () => {
    const directory = join(repository, ".agent-valley/captures", value.id)
    await mkdir(directory, { recursive: true })
    const attachments = []
    for (const [name, mimeType, contents] of [
      ["capture.png", "image/png", "synthetic PNG bytes"],
      ["recording.mp4", "video/mp4", "synthetic MP4 bytes"],
    ] as const) {
      const path = join(directory, name)
      await writeFile(path, contents, { mode: 0o600 })
      attachments.push({
        path,
        name,
        mimeType,
        sizeBytes: Buffer.byteLength(contents),
        sha256: createHash("sha256").update(contents).digest("hex"),
      })
    }
    value.capture = {
      status: "completed",
      startedAt: "2026-10-03T00:00:00Z",
      finishedAt: "2026-10-03T00:00:01Z",
      frames: 1,
      attachments,
      errors: [],
    }
    const before = structuredClone(value)
    await saveAndDeliverMissionReport(value, root)
    expect(value).toEqual(before)
    const fetch = vi.mocked(globalThis.fetch)
    const forms = fetch.mock.calls.flatMap(([, options]) => (options?.body instanceof FormData ? [options.body] : []))
    expect(forms).toHaveLength(3)
    const blobs = forms.map((form) => form.get("files") as File)
    expect(blobs.map((file) => file.name)).toEqual(["capture.png", "recording.mp4", `report-${value.id}.md`])
    expect(await blobs[0]?.text()).toBe("synthetic PNG bytes")
    expect(await blobs[1]?.text()).toBe("synthetic MP4 bytes")
    const markdown = await readFile(join(root, ".agent-valley/reports", `${value.id}.md`), "utf8")
    expect(await blobs[2]?.text()).toBe(markdown)
    expect(markdown).toContain("로그인")
    const receipt = (await listReportDeliveries(join(repository, ".agent-valley")))[0]
    expect(receipt?.status).toBe("delivered")
    expect(receipt?.nextPart).toBe(receipt?.parts)
    expect(receipt?.parts).toBe(fetch.mock.calls.length)
    expect(await listReportDeliveries(join(root, ".agent-valley"))).toEqual([])
    expect(
      (await stat(join(directory, (await readdir(directory)).find((name) => name.startsWith("report-")) ?? "missing")))
        .mode & 0o777,
    ).toBe(0o600)
    const outbox = join(repository, ".agent-valley/report-outbox")
    const saved = await readFile(join(outbox, (await readdir(outbox))[0] ?? "missing"), "utf8")
    expect(saved).not.toContain(hook)
  })

  it("leaves missing native Slack credentials pending and preserves completed work", async () => {
    policy = { destinations: [{ id: "operator", channel: "slack", url_env: "CLI_REPORT_URL" }] }
    configure()
    const before = structuredClone(value)
    await saveAndDeliverMissionReport(value, root)
    expect(value).toEqual(before)
    expect(globalThis.fetch).not.toHaveBeenCalled()
    const receipt = (await listReportDeliveries(join(repository, ".agent-valley")))[0]
    expect(receipt).toMatchObject({ status: "pending", nextPart: 0 })
    expect(receipt?.message).toContain("token_env")
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Retry with av reports retry"))
  })

  it("retries stored report bytes after a channel change without rendering or running an Actor", async () => {
    const fetch = vi.mocked(globalThis.fetch)
    fetch.mockResolvedValue(new Response("unavailable", { status: 503 }))
    await saveAndDeliverMissionReport(value, root)
    const storedReport = await readFile(join(root, ".agent-valley/reports", `${value.id}.md`), "utf8")
    expect((await listReportDeliveries(join(repository, ".agent-valley")))[0]?.status).toBe("failed")
    await rm(join(root, ".agent-valley/reports"), { recursive: true })
    fetch.mockClear()
    fetch.mockImplementation(async () => response())
    const retry = await retryPendingReports(
      { destinations: [{ id: "operator", channel: "discord", url_env: "CLI_REPORT_URL" }] },
      join(repository, ".agent-valley"),
    )
    expect(retry[0]).toMatchObject({ channel: "discord", status: "delivered" })
    expect(String(fetch.mock.calls[0]?.[0])).toContain("wait=true")
    const form = fetch.mock.calls.find(([, options]) => options?.body instanceof FormData)?.[1]?.body as FormData
    const report = form.get("files[0]") as File
    expect(await report.text()).toBe(storedReport)
    expect(report.name).toBe(`report-${value.id}.md`)
    await expect(readFile(join(root, ".agent-valley/reports", `${value.id}.md`))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("writes a local report without creating uploads when reporting is absent", async () => {
    configure(undefined)
    vi.mocked(loadProjectConfig).mockReturnValue(null)
    await saveAndDeliverMissionReport(value, root)
    expect(await readFile(join(root, ".agent-valley/reports", `${value.id}.md`), "utf8")).toContain("로그인")
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(await listReportDeliveries(join(repository, ".agent-valley"))).toEqual([])
    await expect(readdir(join(repository, ".agent-valley/captures"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
