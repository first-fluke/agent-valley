import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  dispatchMissionReport,
  type ReportAttachment,
  type ReportDestination,
  retryPendingReports,
} from "./report-delivery"
import { sha256 } from "./report-delivery-outbox"
import { mission } from "./reports.fixture"

let directory: string
let file: ReportAttachment
const bytes = "native synthetic binary"
const env = {
  HOOK_URL: "https://hooks.example.test/synthetic-hook-secret?thread_id=123",
  BOT_TOKEN: "synthetic-bot-token",
  TG_TOKEN: "12345:synthetic_telegram_token",
  CHAT_ID: "123456789",
  CHANNEL_ID: "synthetic-channel",
  SPACE: "spaces/synthetic-space",
  TEAM_ID: "synthetic-team",
  DRIVE_ID: "synthetic-drive",
  BASE_URL: "https://mattermost.example.test",
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "av-channel-"))
  await mkdir(join(directory, "captures"))
  const path = join(directory, "captures", "capture.png")
  await writeFile(path, bytes)
  file = {
    path,
    name: "capture.png",
    mimeType: "image/png",
    sizeBytes: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
  }
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function provider() {
  return vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = String(input)
    let result: unknown = { ok: true, id: "confirmed-message", name: "spaces/synthetic-space/messages/confirmed" }
    if (url.includes("files.getUploadURLExternal"))
      result = { ok: true, upload_url: "https://files.slack.com/upload/v1/synthetic", file_id: "Fsynthetic" }
    if (url.endsWith("/filesFolder")) result = { id: "folder", parentReference: { driveId: env.DRIVE_ID } }
    if (url.includes("?$select="))
      result = {
        id: "confirmed-file",
        name: file.name,
        eTag: '"{12345678-abcd-4321-abcd-123456789abc},1"',
        webDavUrl: "https://tenant.sharepoint.com/Shared%20Documents/capture.png",
      }
    if (url.includes("attachments:upload"))
      result = { attachmentDataRef: { attachmentUploadToken: "synthetic-reference" } }
    if (url.endsWith("/api/v4/files")) result = { file_infos: [{ id: "confirmed-file" }] }
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } })
  })
}
function destination(channel: string): ReportDestination {
  const common = { id: "operator", channel }
  if (channel === "slack") return { ...common, token_env: "BOT_TOKEN", channel_id_env: "CHANNEL_ID" }
  if (channel === "telegram") return { ...common, token_env: "TG_TOKEN", chat_id_env: "CHAT_ID" }
  if (channel === "teams")
    return {
      ...common,
      token_env: "BOT_TOKEN",
      channel_id_env: "CHANNEL_ID",
      team_id_env: "TEAM_ID",
      drive_id_env: "DRIVE_ID",
    }
  if (channel === "google-chat") return { ...common, token_env: "BOT_TOKEN", space_env: "SPACE" }
  if (channel === "mattermost")
    return { ...common, token_env: "BOT_TOKEN", base_url_env: "BASE_URL", channel_id_env: "CHANNEL_ID" }
  return { ...common, url_env: "HOOK_URL" }
}

describe("native binary attachment adapters", () => {
  it.each(["slack", "discord", "telegram", "teams", "google-chat", "mattermost", "webhook"])(
    "uploads real bytes and confirms the %s native attachment",
    async (channel) => {
      const fetch = provider()
      const result = await dispatchMissionReport(
        mission(),
        "실제 보고서",
        "/reports/local.md",
        { destinations: [destination(channel)], max_attempts: 1 },
        directory,
        { fetch, env, attachments: [file] },
      )
      expect(result[0]).toMatchObject({ channel, status: "delivered", nextPart: 2, parts: 2 })
      for (const [, options] of fetch.mock.calls) expect(options?.redirect).toBe("error")
      if (channel === "slack") {
        const calls = fetch.mock.calls
        expect(calls.map(([url]) => String(url))).toEqual([
          "https://slack.com/api/chat.postMessage",
          "https://slack.com/api/files.getUploadURLExternal",
          "https://files.slack.com/upload/v1/synthetic",
          "https://slack.com/api/files.completeUploadExternal",
        ])
        expect(Buffer.from(calls[2]?.[1]?.body as Uint8Array).toString()).toBe(bytes)
        expect(JSON.parse(calls[1]?.[1]?.body as string)).toEqual({ filename: file.name, length: file.sizeBytes })
        expect(JSON.parse(calls[3]?.[1]?.body as string)).toMatchObject({
          channel_id: env.CHANNEL_ID,
          files: [{ id: "Fsynthetic", title: file.name }],
        })
      }
      if (["discord", "telegram", "mattermost", "webhook"].includes(channel)) {
        const upload = fetch.mock.calls.find(([, options]) => options?.body instanceof FormData)
        expect(upload).toBeDefined()
        const form = upload?.[1]?.body as FormData
        const field = channel === "discord" ? "files[0]" : channel === "telegram" ? "photo" : "files"
        const blob = form.get(field) as File
        expect(blob.name).toBe(file.name)
        expect(await blob.text()).toBe(bytes)
        if (channel === "discord") {
          expect(String(upload?.[0])).toContain("wait=true")
          expect(String(upload?.[0])).toContain("thread_id=123")
          expect(JSON.parse(form.get("payload_json") as string)).toMatchObject({
            allowed_mentions: { parse: [] },
            attachments: [{ id: 0, filename: file.name }],
          })
        }
        if (channel === "telegram") {
          expect(String(upload?.[0]).endsWith("/sendPhoto")).toBe(true)
          expect(form.get("chat_id")).toBe(env.CHAT_ID)
        }
        if (channel === "mattermost") {
          expect(form.get("channel_id")).toBe(env.CHANNEL_ID)
          expect(JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body as string).file_ids).toEqual(["confirmed-file"])
        }
        if (channel === "webhook") {
          expect(new Headers(upload?.[1]?.headers).get("Idempotency-Key")).toBe(`${result[0]?.id}.2`)
          const payload = JSON.parse(form.get("payload_json") as string)
          expect(payload.attachment).toEqual({
            name: file.name,
            mime_type: file.mimeType,
            size_bytes: file.sizeBytes,
            sha256: file.sha256,
          })
          expect(JSON.stringify(payload)).not.toContain(file.path)
        }
      }
      if (channel === "google-chat") {
        const upload = fetch.mock.calls.find(([url]) => String(url).includes("attachments:upload"))
        expect(new Headers(upload?.[1]?.headers).get("Content-Type")).toContain("multipart/related")
        const uploadBody = upload?.[1]?.body as Blob
        const body = await uploadBody.text()
        expect(body).toContain(bytes)
        expect(body).toContain(JSON.stringify({ filename: file.name }))
        expect(JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body as string).attachment).toEqual([
          { attachmentDataRef: { attachmentUploadToken: "synthetic-reference" } },
        ])
      }
      if (channel === "teams") {
        const upload = fetch.mock.calls.find(([url]) => String(url).endsWith(":/content"))
        expect(upload?.[1]?.method).toBe("PUT")
        expect(Buffer.from(upload?.[1]?.body as Uint8Array).toString()).toBe(bytes)
        expect(String(upload?.[0])).toContain("/drives/synthetic-drive/items/folder:/")
        const message = JSON.parse(fetch.mock.calls.at(-1)?.[1]?.body as string)
        expect(message.attachments).toEqual([
          {
            id: "12345678-abcd-4321-abcd-123456789abc",
            contentType: "reference",
            contentUrl: "https://tenant.sharepoint.com/Shared%20Documents/capture.png",
            name: file.name,
          },
        ])
        expect(message.body.content).toContain('<attachment id="12345678-abcd-4321-abcd-123456789abc">')
      }
    },
  )

  it.each(["slack", "teams", "google-chat", "mattermost"])(
    "keeps %s webhook-only destinations pending when native upload credentials are missing",
    async (channel) => {
      const fetch = provider()
      const result = await dispatchMissionReport(
        mission(),
        "report",
        "/report.md",
        { destinations: [{ id: "operator", channel, url_env: "HOOK_URL" }] },
        directory,
        { fetch, env, attachments: [file] },
      )
      expect(result[0]).toMatchObject({ status: "pending", nextPart: 0 })
      expect(result[0]?.message).toContain("token_env")
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(["slack", "google-chat", "mattermost", "teams"])(
    "requires %s native provider confirmation after binary upload",
    async (channel) => {
      const fetch = provider()
      const original = fetch.getMockImplementation()
      fetch.mockImplementation(async (url, options) => {
        const name = String(url)
        const final =
          name.includes("completeUploadExternal") ||
          (name.includes("/messages") && options?.body?.toString().includes("attachment")) ||
          (name.endsWith("/api/v4/posts") && options?.body?.toString().includes("file_ids"))
        return final
          ? new Response(JSON.stringify({ error: "synthetic provider failure" }), { status: 200 })
          : (original as typeof fetch)(url, options)
      })
      const result = await dispatchMissionReport(
        mission(),
        "report",
        "/report.md",
        { destinations: [destination(channel)], max_attempts: 1 },
        directory,
        { fetch, env, attachments: [file] },
      )
      expect(result[0]).toMatchObject({ status: "pending", nextPart: 1 })
      expect(result[0]?.message).toContain("rejected delivery")
    },
  )

  it("uses Telegram native video and document methods for recorded media", async () => {
    const fetch = provider()
    for (const [mimeType, name, method] of [
      ["video/mp4", "capture.mp4", "sendVideo"],
      ["application/pdf", "capture.pdf", "sendDocument"],
    ] as const) {
      await dispatchMissionReport(
        mission(),
        name,
        "/report.md",
        { destinations: [destination("telegram")] },
        directory,
        { fetch, env, attachments: [{ ...file, mimeType, name }] },
      )
      expect(String(fetch.mock.calls.at(-1)?.[0]).endsWith(`/${method}`)).toBe(true)
      const field = method === "sendVideo" ? "video" : "document"
      const uploadBody = fetch.mock.calls.at(-1)?.[1]?.body as FormData
      expect(await (uploadBody.get(field) as Blob).text()).toBe(bytes)
    }
  })

  it("does not mistake Telegram HTTP success for a successful Bot API operation", async () => {
    const fetch = provider().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: env.TG_TOKEN }), { status: 200 }),
    )
    const result = await dispatchMissionReport(
      mission(),
      "report",
      "/report.md",
      { destinations: [destination("telegram")] },
      directory,
      { fetch, env, attachments: [file] },
    )
    expect(result[0]?.status).toBe("pending")
    expect(result[0]?.message).not.toContain(env.TG_TOKEN)
    const outbox = join(directory, "report-outbox")
    const content = await readFile(join(outbox, (await readdir(outbox))[0] ?? "missing-record.json"), "utf8")
    expect(content).not.toContain(env.TG_TOKEN)
  })

  it("keeps an attachment upload failure durable and retries only that native file", async () => {
    const fetch = provider()
    const original = fetch.getMockImplementation()
    fetch.mockImplementation(async (url, options) =>
      options?.body instanceof FormData
        ? new Response("failure", { status: 503 })
        : (original as typeof fetch)(url, options),
    )
    const config = { destinations: [destination("discord")], max_attempts: 1 }
    const result = await dispatchMissionReport(mission(), "report", "/report.md", config, directory, {
      fetch,
      env,
      attachments: [file],
    })
    expect(result[0]).toMatchObject({ status: "failed", nextPart: 1 })
    const retry = provider()
    const replay = await retryPendingReports(config, directory, { fetch: retry, env })
    expect(replay[0]?.status).toBe("delivered")
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData)
  })

  it("rejects an unexpected Slack upload host and mismatched Teams drive before transferring bytes", async () => {
    const slack = provider().mockImplementation(
      async (url) =>
        new Response(
          JSON.stringify(
            String(url).includes("getUploadURLExternal")
              ? { ok: true, upload_url: "https://untrusted.example.test/upload", file_id: "Fsynthetic" }
              : { ok: true },
          ),
          { status: 200 },
        ),
    )
    const first = await dispatchMissionReport(
      mission(),
      "slack",
      "/report.md",
      { destinations: [destination("slack")] },
      directory,
      { fetch: slack, env, attachments: [file] },
    )
    expect(first[0]?.status).toBe("pending")
    expect(slack).toHaveBeenCalledTimes(2)
    const teams = provider()
    const second = await dispatchMissionReport(
      mission(),
      "teams",
      "/report.md",
      { destinations: [destination("teams")] },
      directory,
      { fetch: teams, env: { ...env, DRIVE_ID: "wrong-drive" }, attachments: [file] },
    )
    expect(second[0]?.status).toBe("pending")
    expect(second[0]?.message).toContain("drive_id_env")
    expect(teams).toHaveBeenCalledTimes(2)
  })
})
