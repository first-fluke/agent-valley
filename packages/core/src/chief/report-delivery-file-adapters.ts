import type { ReportChannelRequest } from "../domain/ports/report-channel"
import { ReportDeliveryError } from "./report-delivery-contract"
import { httpsUrl, multipartFile, type ReportHttp } from "./report-delivery-http"

/** Slack's retired files.upload API is deliberately replaced by the external-upload flow. */
export async function uploadSlack(request: ReportChannelRequest, http: ReportHttp): Promise<void> {
  const { attachment, bytes, destination, signal } = request
  if (!attachment || !bytes) return
  const info = await http.json(
    "https://slack.com/api/files.getUploadURLExternal",
    { filename: attachment.name, length: bytes.byteLength },
    signal,
    destination.token,
  )
  http.confirmed(info)
  if (typeof info.upload_url !== "string" || typeof info.file_id !== "string") throw unconfirmed()
  // This URL is issued by Slack, not by the model or a saved outbox entry.
  const uploadUrl = new URL(httpsUrl(info.upload_url))
  if (!uploadUrl.hostname.endsWith(".slack.com")) throw unconfirmed()
  await http.request(uploadUrl.toString(), { method: "POST", body: bytes }, signal)
  const result = await http.json(
    "https://slack.com/api/files.completeUploadExternal",
    {
      files: [{ id: info.file_id, title: attachment.name }],
      channel_id: destination.channelId,
      initial_comment: request.text,
    },
    signal,
    destination.token,
  )
  http.confirmed(result)
}

export async function uploadGoogleChat(request: ReportChannelRequest, http: ReportHttp): Promise<void> {
  const { attachment, bytes, destination, signal } = request
  if (!attachment || !bytes) return
  const space = googleSpace(destination.space)
  // Google media uploads use multipart/related, not multipart/form-data.
  const boundary = `av-${request.report.idempotencyKey}-${request.part}`
  const prefix = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename: attachment.name })}\r\n--${boundary}\r\nContent-Type: ${attachment.mimeType}\r\n\r\n`
  const body = new Blob([prefix, bytes, `\r\n--${boundary}--\r\n`])
  const upload = await http.object(
    await http.request(
      `https://chat.googleapis.com/upload/v1/${space}/attachments:upload?uploadType=multipart`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${destination.token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
      signal,
    ),
  )
  if (!upload.attachmentDataRef || typeof upload.attachmentDataRef !== "object") throw unconfirmed()
  const result = await http.json(
    googleMessageUrl(request),
    { text: request.text, attachment: [upload] },
    signal,
    destination.token,
  )
  http.confirmed(result, "name")
}

export function googleSpace(space: string | undefined): string {
  if (!space || !/^spaces\/[a-zA-Z0-9_-]+$/.test(space))
    throw new ReportDeliveryError(
      "Set space_env to a Google Chat resource name such as spaces/SPACE_ID and retry av reports.",
      true,
      false,
    )
  return space
}

export function googleMessageUrl(request: ReportChannelRequest): string {
  const id = `client-av-${request.report.idempotencyKey.slice(0, 48)}-${request.part}`
  return `https://chat.googleapis.com/v1/${googleSpace(request.destination.space)}/messages?messageId=${id}`
}

export async function uploadMattermost(request: ReportChannelRequest, http: ReportHttp): Promise<void> {
  const form = multipartFile(request, "files")
  form.append("channel_id", request.destination.channelId ?? "")
  const base = request.destination.baseUrl?.replace(/\/$/, "")
  const uploaded = await http.object(
    await http.request(
      `${base}/api/v4/files`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${request.destination.token}` },
        body: form,
      },
      request.signal,
    ),
  )
  const infos = uploaded.file_infos
  if (!Array.isArray(infos) || infos.length !== 1 || typeof infos[0]?.id !== "string") throw unconfirmed()
  const result = await http.json(
    `${base}/api/v4/posts`,
    {
      channel_id: request.destination.channelId,
      message: request.text,
      file_ids: [infos[0].id],
    },
    request.signal,
    request.destination.token,
  )
  http.confirmed(result, "id")
}

/** Upload into the selected channel's actual SharePoint folder, then create a native file reference. */
export async function uploadTeams(request: ReportChannelRequest, http: ReportHttp): Promise<void> {
  const { destination, attachment, bytes, signal } = request
  if (!attachment || !bytes) return
  const channelUrl = teamsChannelUrl(request)
  const headers = { Authorization: `Bearer ${destination.token}` }
  const folder = await http.object(await http.request(`${channelUrl}/filesFolder`, { headers }, signal))
  const parent = folder.parentReference as { driveId?: unknown } | undefined
  if (typeof folder.id !== "string" || parent?.driveId !== destination.driveId)
    throw new ReportDeliveryError(
      "Teams drive_id_env must identify this channel's SharePoint drive. Fix it and retry av reports.",
      true,
      false,
    )
  const filename = `${request.report.idempotencyKey.slice(0, 16)}-${attachment.name}`
  const base = `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(destination.driveId ?? "")}/items`
  const uploaded = await http.object(
    await http.request(
      `${base}/${encodeURIComponent(folder.id)}:/${encodeURIComponent(filename)}:/content`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": attachment.mimeType },
        body: bytes,
      },
      signal,
    ),
  )
  if (typeof uploaded.id !== "string") throw unconfirmed()
  const item = await http.object(
    await http.request(
      `${base}/${encodeURIComponent(uploaded.id)}?$select=id,name,eTag,webDavUrl`,
      { headers },
      signal,
    ),
  )
  const id = typeof item.eTag === "string" ? item.eTag.match(/\{([a-fA-F0-9-]{36})\}/)?.[1] : undefined
  if (!id || typeof item.webDavUrl !== "string") throw unconfirmed()
  const result = await http.json(
    `${channelUrl}/messages`,
    {
      body: { contentType: "html", content: `${escapeHtml(request.text)}<attachment id="${id}"></attachment>` },
      attachments: [{ id, contentType: "reference", contentUrl: httpsUrl(item.webDavUrl), name: attachment.name }],
    },
    signal,
    destination.token,
  )
  http.confirmed(result, "id")
}

export function teamsChannelUrl(request: ReportChannelRequest): string {
  return `https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(request.destination.teamId ?? "")}/channels/${encodeURIComponent(request.destination.channelId ?? "")}`
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function unconfirmed(): ReportDeliveryError {
  return new ReportDeliveryError(
    "File upload was not confirmed by the provider. Check native attachment API permissions and retry av reports.",
    true,
    false,
  )
}
