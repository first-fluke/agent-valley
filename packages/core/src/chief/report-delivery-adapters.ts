import type {
  ReportChannelPort,
  ReportChannelRegistry,
  ResolvedReportDestination,
} from "../domain/ports/report-channel"
import { ReportDeliveryError } from "./report-delivery-contract"
import {
  escapeHtml,
  googleMessageUrl,
  teamsChannelUrl,
  uploadGoogleChat,
  uploadMattermost,
  uploadSlack,
  uploadTeams,
} from "./report-delivery-file-adapters"
import { createReportHttp, multipartFile, requireFields } from "./report-delivery-http"

/** Each registry is created with an injected transport; callers can replace any channel Port. */
export function createReportChannelRegistry(fetch: typeof globalThis.fetch): ReportChannelRegistry {
  const http = createReportHttp(fetch)
  const slack: ReportChannelPort = {
    validate(destination, files) {
      if (files || !destination.url) requireFields(destination, ["token", "channelId"])
      else requireFields(destination, ["url"])
    },
    async send(request) {
      if (request.attachment) return uploadSlack(request, http)
      const body = {
        text: request.text,
        blocks: [{ type: "section", text: { type: "plain_text", text: request.text } }],
      }
      if (request.destination.url) {
        await http.request(request.destination.url, jsonOptions(body), request.signal)
      } else {
        const result = await http.json(
          "https://slack.com/api/chat.postMessage",
          { ...body, channel: request.destination.channelId, parse: "none", unfurl_links: false, unfurl_media: false },
          request.signal,
          request.destination.token,
        )
        http.confirmed(result)
      }
    },
  }
  const discord: ReportChannelPort = {
    validate: (destination) => requireFields(destination, ["url"]),
    async send(request) {
      const url = new URL(request.destination.url ?? "")
      url.searchParams.set("wait", "true")
      const payload = {
        content: request.text,
        allowed_mentions: { parse: [] as string[] },
        ...(request.attachment ? { attachments: [{ id: 0, filename: request.attachment.name }] } : {}),
      }
      const options: RequestInit = request.attachment
        ? { method: "POST", body: multipartFile(request, "files[0]") }
        : jsonOptions(payload)
      if (options.body instanceof FormData) options.body.append("payload_json", JSON.stringify(payload))
      const result = await http.object(await http.request(url.toString(), options, request.signal))
      http.confirmed(result, "id")
    },
  }
  const telegram: ReportChannelPort = {
    validate(destination) {
      requireFields(destination, ["token", "chatId"])
      if (!/^\d+:[a-zA-Z0-9_-]+$/.test(destination.token ?? ""))
        throw new ReportDeliveryError("Set token_env to a valid Telegram bot token and retry av reports.", true, false)
    },
    async send(request) {
      const attachment = request.attachment
      let method = "sendMessage"
      let options: RequestInit = jsonOptions({ chat_id: request.destination.chatId, text: request.text })
      if (attachment) {
        if (attachment.sizeBytes > 50 * 1024 * 1024)
          throw new ReportDeliveryError(
            "Telegram capture exceeds the Bot API upload limit. Produce a capture below 50 MB and retry av reports.",
            true,
            false,
          )
        const photo =
          ["image/png", "image/jpeg"].includes(attachment.mimeType) && attachment.sizeBytes <= 10 * 1024 * 1024
        const field = photo ? "photo" : attachment.mimeType === "video/mp4" ? "video" : "document"
        method = photo ? "sendPhoto" : field === "video" ? "sendVideo" : "sendDocument"
        const form = multipartFile(request, field)
        form.append("chat_id", request.destination.chatId ?? "")
        form.append("caption", request.text.slice(0, 1_000))
        options = { method: "POST", body: form }
      }
      const result = await http.object(
        await http.request(
          `https://api.telegram.org/bot${request.destination.token}/${method}`,
          options,
          request.signal,
        ),
      )
      http.confirmed(result)
    },
  }
  const teams: ReportChannelPort = {
    validate(destination, files) {
      if (files || !destination.url)
        requireFields(destination, ["token", "teamId", "channelId", ...(files ? ["driveId" as const] : [])])
      else requireFields(destination, ["url"])
    },
    async send(request) {
      if (request.attachment) return uploadTeams(request, http)
      if (request.destination.url) {
        await http.request(
          request.destination.url,
          jsonOptions({
            type: "message",
            attachments: [
              {
                contentType: "application/vnd.microsoft.card.adaptive",
                contentUrl: null,
                content: {
                  $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
                  type: "AdaptiveCard",
                  version: "1.2",
                  body: [{ type: "TextBlock", text: request.text, wrap: true }],
                },
              },
            ],
          }),
          request.signal,
        )
      } else {
        const result = await http.json(
          `${teamsChannelUrl(request)}/messages`,
          { body: { contentType: "html", content: escapeHtml(request.text) } },
          request.signal,
          request.destination.token,
        )
        http.confirmed(result, "id")
      }
    },
  }
  const googleChat: ReportChannelPort = {
    validate: (destination, files) => validateBotOrWebhook(destination, files, ["token", "space"]),
    async send(request) {
      if (request.attachment) return uploadGoogleChat(request, http)
      if (request.destination.url)
        await http.request(request.destination.url, jsonOptions({ text: request.text }), request.signal)
      else
        http.confirmed(
          await http.json(googleMessageUrl(request), { text: request.text }, request.signal, request.destination.token),
          "name",
        )
    },
  }
  const mattermost: ReportChannelPort = {
    validate: (destination, files) => validateBotOrWebhook(destination, files, ["token", "baseUrl", "channelId"]),
    async send(request) {
      if (request.attachment) return uploadMattermost(request, http)
      if (request.destination.url)
        await http.request(request.destination.url, jsonOptions({ text: request.text }), request.signal)
      else
        http.confirmed(
          await http.json(
            `${request.destination.baseUrl?.replace(/\/$/, "")}/api/v4/posts`,
            { channel_id: request.destination.channelId, message: request.text },
            request.signal,
            request.destination.token,
          ),
          "id",
        )
    },
  }
  const webhook: ReportChannelPort = {
    validate: (destination) => requireFields(destination, ["url"]),
    async send(request) {
      const payload = {
        mission_id: request.report.missionId,
        status: request.report.missionStatus,
        goal: request.report.goal,
        report_hash: request.report.reportHash,
        part: request.part,
        parts: request.parts,
        markdown: request.text,
        ...(request.attachment
          ? {
              attachment: {
                name: request.attachment.name,
                mime_type: request.attachment.mimeType,
                size_bytes: request.attachment.sizeBytes,
                sha256: request.attachment.sha256,
              },
            }
          : {}),
      }
      const headers = {
        "Idempotency-Key": `${request.report.idempotencyKey}.${request.part}`,
        ...(request.destination.token ? { Authorization: `Bearer ${request.destination.token}` } : {}),
      }
      const options = request.attachment
        ? { method: "POST", body: multipartFile(request, "files"), headers }
        : { ...jsonOptions(payload), headers: { ...headers, "Content-Type": "application/json" } }
      if (options.body instanceof FormData) options.body.append("payload_json", JSON.stringify(payload))
      await http.request(request.destination.url ?? "", options, request.signal)
    },
  }
  return { slack, discord, telegram, teams, webhook, "google-chat": googleChat, mattermost }
}

function jsonOptions(body: unknown): RequestInit & { method: string } {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
}

function validateBotOrWebhook(
  destination: ResolvedReportDestination,
  files: boolean,
  fields: (keyof ResolvedReportDestination)[],
): void {
  requireFields(destination, files || !destination.url ? fields : ["url"])
}
