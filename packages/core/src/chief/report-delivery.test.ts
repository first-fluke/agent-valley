import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  dispatchMissionReport,
  listReportDeliveries,
  type ReportAttachment,
  type ReportChannelRequest,
  type ReportDeliveryPolicy,
  reportDeliveryPolicySchema,
  retryPendingReports,
} from "./report-delivery"
import { ReportDeliveryError } from "./report-delivery-contract"
import { sha256 } from "./report-delivery-outbox"
import { mission } from "./reports.fixture"

let directory: string
const env = { REPORT_URL: "https://hooks.example.test/synthetic-secret", REPORT_TOKEN: "synthetic-token" }
const policy: ReportDeliveryPolicy = {
  destinations: [{ id: "operator", channel: "webhook", url_env: "REPORT_URL", token_env: "REPORT_TOKEN" }],
  max_attempts: 1,
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-report-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function transport(status = 200) {
  return vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status }))
}
async function attachment(name = "capture.png", contents = "synthetic capture"): Promise<ReportAttachment> {
  await mkdir(join(directory, "captures"), { recursive: true })
  const path = join(directory, "captures", name)
  await writeFile(path, contents)
  return { path, name, mimeType: "image/png", sizeBytes: Buffer.byteLength(contents), sha256: sha256(contents) }
}
async function records(): Promise<string[]> {
  const path = join(directory, "report-outbox")
  return Promise.all(
    (await readdir(path)).filter((name) => name.endsWith(".json")).map((name) => readFile(join(path, name), "utf8")),
  )
}

describe("report delivery configuration", () => {
  it("supports custom Ports, bounded defaults, and environment names only", () => {
    const parsed = reportDeliveryPolicySchema.parse({ destinations: [{ id: "custom", channel: "internal-audit" }] })
    expect(parsed).toMatchObject({ timeout_ms: 10_000, max_attempts: 3, events: ["completed", "failed"] })
    for (const destination of [
      { id: "bad", channel: "webhook", url: env.REPORT_URL },
      { id: "bad", channel: "telegram", token: env.REPORT_TOKEN },
      { id: "bad", channel: "webhook", url_env: env.REPORT_URL },
    ])
      expect(reportDeliveryPolicySchema.safeParse({ destinations: [destination] }).success).toBe(false)
    expect(
      reportDeliveryPolicySchema.safeParse({
        ...policy,
        destinations: [...policy.destinations, ...policy.destinations],
      }).success,
    ).toBe(false)
    expect(reportDeliveryPolicySchema.safeParse({ ...policy, events: ["completed", "completed"] }).success).toBe(false)
    expect(reportDeliveryPolicySchema.safeParse({ ...policy, timeout_ms: 60_001 }).success).toBe(false)
    expect(reportDeliveryPolicySchema.safeParse({ ...policy, max_attempts: 11 }).success).toBe(false)
  })
})

describe("durable report delivery", () => {
  it("persists pending before transport, uses private files, and deduplicates delivered reports", async () => {
    const fetch = transport()
    fetch.mockImplementation(async (_url, options) => {
      expect((await listReportDeliveries(directory))[0]).toMatchObject({ status: "pending", nextPart: 0 })
      expect(options?.redirect).toBe("error")
      return new Response(null, { status: 200 })
    })
    const result = await dispatchMissionReport(mission(), "완료 보고서", "/reports/report.md", policy, directory, {
      fetch,
      env,
    })
    expect(result[0]).toMatchObject({ status: "delivered", attempts: 1, nextPart: 1, parts: 1 })
    await dispatchMissionReport(mission(), "완료 보고서", "/reports/report.md", policy, directory, { fetch, env })
    await retryPendingReports(policy, directory, { fetch, env })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((await stat(join(directory, "report-outbox", `${result[0]?.id}.json`))).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, "report-outbox"))).mode & 0o777).toBe(0o700)
    expect(await listReportDeliveries(directory)).toEqual(result)
  })

  it("preserves mission outcome when a channel fails and retries saved Markdown through current env", async () => {
    const value = mission()
    const original = structuredClone(value)
    const fetch = transport(503)
    fetch.mockImplementation(async () => {
      expect((await listReportDeliveries(directory))[0]?.status).toBe("pending")
      return new Response(null, { status: 503 })
    })
    const result = await dispatchMissionReport(
      value,
      "저장된 보고서",
      "/reports/report.md",
      { ...policy, max_attempts: 2 },
      directory,
      { fetch, env },
    )
    expect(result[0]).toMatchObject({ status: "failed", attempts: 2, nextPart: 0 })
    expect(value).toEqual(original)
    expect(fetch).toHaveBeenCalledTimes(2)
    await dispatchMissionReport(value, "저장된 보고서", "/reports/report.md", policy, directory, { fetch, env })
    expect(fetch).toHaveBeenCalledTimes(2)
    const current = transport()
    const replayed = await retryPendingReports(policy, directory, {
      fetch: current,
      env: { ...env, REPORT_URL: "https://new.example.test/rotated-secret" },
    })
    expect(replayed[0]).toMatchObject({ status: "delivered", attempts: 3 })
    expect(current.mock.calls[0]?.[0]).toBe("https://new.example.test/rotated-secret")
    expect(JSON.parse(current.mock.calls[0]?.[1]?.body as string).markdown).toContain("저장된 보고서")
  })

  it("fans out independently and can replace a pending channel by its destination id", async () => {
    const fetch = transport()
    const multi: ReportDeliveryPolicy = {
      destinations: [...policy.destinations, { id: "custom", channel: "company-inbox" }],
      max_attempts: 1,
    }
    const bad = vi.fn().mockRejectedValue(new Error("transport contains a synthetic-token"))
    const first = await dispatchMissionReport(mission(), "보고서", "/reports/report.md", multi, directory, {
      fetch,
      env,
      registry: { "company-inbox": { send: bad } },
    })
    expect(first.map((entry) => entry.status)).toEqual(["delivered", "failed"])
    const send = vi.fn().mockResolvedValue(undefined)
    const second = await retryPendingReports({ destinations: [{ id: "custom", channel: "replacement" }] }, directory, {
      fetch,
      env,
      registry: { replacement: { send } },
    })
    expect(second[0]).toMatchObject({ channel: "replacement", status: "delivered" })
    expect(send).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("keeps missing configuration pending with remediation and never sends insecure URLs", async () => {
    const fetch = transport()
    let result = await dispatchMissionReport(mission(), "보고서", "/report.md", policy, directory, { fetch, env: {} })
    expect(result[0]).toMatchObject({ status: "pending", attempts: 0 })
    expect(result[0]?.message).toContain("REPORT_URL")
    result = await retryPendingReports(policy, directory, {
      fetch,
      env: { ...env, REPORT_URL: "http://example.test/hook" },
    })
    expect(result[0]?.message).toContain("HTTPS")
    expect(fetch).not.toHaveBeenCalled()
    result = await retryPendingReports({ destinations: [] }, directory, { fetch, env })
    expect(result[0]).toMatchObject({ status: "pending" })
    expect(result[0]?.message).toContain("av.yaml")
  })

  it("stores neither destination credentials nor credential-bearing error messages", async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ReportDeliveryError(`Failure ${env.REPORT_TOKEN} ${env.REPORT_URL}`, true, false))
    const markdown = `${env.REPORT_TOKEN} ${env.REPORT_URL} 보고서`
    const result = await dispatchMissionReport(
      mission(),
      markdown,
      `/reports/${env.REPORT_TOKEN}.md`,
      policy,
      directory,
      { env, registry: { webhook: { send } } },
    )
    const persisted = (await records()).join("")
    for (const secret of Object.values(env)) {
      expect(persisted).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain(secret)
    }
    expect(persisted).toContain("[redacted]")
  })

  it("filters events and running missions and gives different reports independent dedupe keys", async () => {
    const fetch = transport()
    expect(await dispatchMissionReport(mission(), "x", "/report.md", undefined, directory, { fetch, env })).toEqual([])
    expect(
      await dispatchMissionReport({ ...mission(), status: "executing" }, "x", "/report.md", policy, directory, {
        fetch,
        env,
      }),
    ).toEqual([])
    expect(
      await dispatchMissionReport(mission(), "x", "/report.md", { ...policy, events: ["failed"] }, directory, {
        fetch,
        env,
      }),
    ).toEqual([])
    const completed = await dispatchMissionReport(mission(), "one", "/report.md", policy, directory, { fetch, env })
    const changed = await dispatchMissionReport(mission(), "two", "/report.md", policy, directory, { fetch, env })
    const failed = await dispatchMissionReport(
      { ...mission(), status: "failed" },
      "one",
      "/report.md",
      policy,
      directory,
      { fetch, env },
    )
    expect(new Set([...completed, ...changed, ...failed].map((entry) => entry.id)).size).toBe(3)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("resumes after the last confirmed part and replays the whole report after destination rotation", async () => {
    const parts: number[] = []
    const send = vi.fn(async (request) => {
      parts.push(request.part)
      if (request.part === 2) throw new Error("offline")
    })
    const markdown = "한글🙂".repeat(500)
    const first = await dispatchMissionReport(mission(), markdown, "/report.md", policy, directory, {
      env,
      registry: { webhook: { send } },
    })
    expect(first[0]).toMatchObject({ status: "failed", nextPart: 1 })
    const resume = vi.fn().mockResolvedValue(undefined)
    await retryPendingReports(policy, directory, { env, registry: { webhook: { send: resume } } })
    expect(resume.mock.calls[0]?.[0].part).toBe(2)
    expect(parts).toEqual([1, 2])
    const fresh = await dispatchMissionReport(mission(), `${markdown} changed`, "/report.md", policy, directory, {
      env,
      registry: { webhook: { send } },
    })
    expect(fresh[0]?.nextPart).toBe(1)
    const rotated = vi.fn().mockResolvedValue(undefined)
    await retryPendingReports(policy, directory, {
      env: { ...env, REPORT_URL: "https://rotated.example.test/hook" },
      registry: { webhook: { send: rotated } },
    })
    expect(rotated.mock.calls[0]?.[0].part).toBe(1)
    const texts = rotated.mock.calls.map(([request]) => request.text.split("\n").slice(1).join("\n")).join("")
    expect(texts).toBe(`${markdown} changed`)
  })

  it("deduplicates concurrent dispatches using the existing process lock", async () => {
    let release: (() => void) | undefined
    let started: (() => void) | undefined
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const send = vi.fn(async () => {
      started?.()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })
    const deps = { env, registry: { webhook: { send } } }
    const first = dispatchMissionReport(mission(), "report", "/report.md", policy, directory, deps)
    await entered
    const duplicate = await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, deps)
    expect(duplicate[0]?.status).toBe("pending")
    release?.()
    expect((await first)[0]?.status).toBe("delivered")
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("bounds Ports that ignore abort and leaves the report retryable", async () => {
    const send = vi.fn<(request: ReportChannelRequest) => Promise<void>>(() => new Promise<void>(() => {}))
    const result = await dispatchMissionReport(
      mission(),
      "report",
      "/report.md",
      { ...policy, timeout_ms: 1_000 },
      directory,
      { env, registry: { webhook: { send } } },
    )
    expect(result[0]).toMatchObject({ status: "failed", attempts: 1 })
    expect(result[0]?.message).toContain("timed out")
    expect(send.mock.calls[0]?.[0]?.signal.aborted).toBe(true)
  })
})

describe("durable real attachments", () => {
  it("delivers every capture at the maximum 300-frame count plus video, manifest and report", async () => {
    const file = await attachment()
    const attachments = Array.from({ length: 303 }, (_, index) => ({ ...file, name: `capture-${index}.png` }))
    const send = vi.fn().mockResolvedValue(undefined)
    const result = await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments,
      registry: { webhook: { send } },
    })
    expect(result[0]).toMatchObject({ status: "delivered", nextPart: 304, parts: 304 })
    expect(send).toHaveBeenCalledTimes(304)
    expect(send.mock.calls.slice(1).map(([request]) => request.attachment.name)).toEqual(
      attachments.map((entry) => entry.name),
    )
  })

  it("uploads actual bytes and requires all files before marking delivered", async () => {
    const file = await attachment()
    const send = vi.fn(async (request) => {
      if (request.attachment) {
        expect(Buffer.from(request.bytes).toString()).toBe("synthetic capture")
        expect((await listReportDeliveries(directory))[0]).toMatchObject({ status: "pending", nextPart: 1 })
      }
    })
    const result = await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments: [file],
      registry: { webhook: { send } },
    })
    expect(result[0]).toMatchObject({ status: "delivered", nextPart: 2, parts: 2 })
    expect(send).toHaveBeenCalledTimes(2)
    await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments: [file],
      registry: { webhook: { send } },
    })
    expect(send).toHaveBeenCalledTimes(2)
    const changed = await attachment("changed.png", "other capture")
    const next = await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments: [changed],
      registry: { webhook: { send } },
    })
    expect(next[0]?.id).not.toBe(result[0]?.id)
  })

  it("retries only the failed file and detects changed or deleted capture content", async () => {
    const file = await attachment()
    const send = vi.fn(async (request) => {
      if (request.attachment) throw new Error("upload failed")
    })
    await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments: [file],
      registry: { webhook: { send } },
    })
    await writeFile(file.path, "modified capture!")
    const replay = vi.fn().mockResolvedValue(undefined)
    const result = await retryPendingReports(policy, directory, { env, registry: { webhook: { send: replay } } })
    expect(result[0]).toMatchObject({ status: "pending", nextPart: 1 })
    expect(result[0]?.message).toContain("missing, changed")
    expect(replay).not.toHaveBeenCalled()
    await writeFile(file.path, "synthetic capture")
    const restored = await retryPendingReports(policy, directory, { env, registry: { webhook: { send: replay } } })
    expect(restored[0]?.status).toBe("delivered")
    expect(replay).toHaveBeenCalledTimes(1)
    expect(replay.mock.calls[0]?.[0].attachment.sha256).toBe(file.sha256)
  })

  it("rejects escaped and symlinked files before sending report text", async () => {
    const file = await attachment()
    const send = vi.fn().mockResolvedValue(undefined)
    const outside = join(directory, "outside.png")
    await writeFile(outside, "synthetic capture")
    const escaped = { ...file, path: outside }
    const result = await dispatchMissionReport(mission(), "report", "/report.md", policy, directory, {
      env,
      attachments: [escaped],
      registry: { webhook: { send } },
    })
    expect(result[0]?.status).toBe("pending")
    const link = join(directory, "captures", "link.png")
    await symlink(file.path, link)
    const linked = await dispatchMissionReport(mission(), "report 2", "/report.md", policy, directory, {
      env,
      attachments: [{ ...file, path: link }],
      registry: { webhook: { send } },
    })
    expect(linked[0]?.status).toBe("pending")
    expect(send).not.toHaveBeenCalled()
  })
})
