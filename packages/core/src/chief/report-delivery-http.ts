import type { ReportChannelRequest, ResolvedReportDestination } from "../domain/ports/report-channel"
import { ReportDeliveryError, type ReportDestination } from "./report-delivery-contract"

export function httpsUrl(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password || url.hash || value.length > 8_192) throw new Error()
    return url.toString()
  } catch {
    throw new ReportDeliveryError(
      "Report destination must be an HTTPS URL without user credentials or fragments. Fix its environment variable and retry av reports.",
      true,
      false,
    )
  }
}

export function resolveReportDestination(
  config: ReportDestination,
  env: Record<string, string | undefined>,
): ResolvedReportDestination {
  const result: ResolvedReportDestination = {}
  const fields = {
    url_env: "url",
    token_env: "token",
    chat_id_env: "chatId",
    channel_id_env: "channelId",
    space_env: "space",
    team_id_env: "teamId",
    drive_id_env: "driveId",
    base_url_env: "baseUrl",
  } as const
  for (const [field, target] of Object.entries(fields)) {
    const name = config[field as keyof typeof fields]
    if (!name) continue
    const value = env[name]
    if (!value?.trim() || value.length > 8_192 || /[\r\n\0]/.test(value))
      throw new ReportDeliveryError(
        `Set ${name} for report destination ${config.id}, then retry av reports.`,
        true,
        false,
      )
    result[target] = target === "url" || target === "baseUrl" ? httpsUrl(value) : value
  }
  return result
}

export function requireFields(
  destination: ResolvedReportDestination,
  fields: (keyof ResolvedReportDestination)[],
): void {
  const configNames = {
    url: "url_env",
    token: "token_env",
    chatId: "chat_id_env",
    channelId: "channel_id_env",
    space: "space_env",
    teamId: "team_id_env",
    driveId: "drive_id_env",
    baseUrl: "base_url_env",
  }
  const missing = fields.filter((field) => !destination[field])
  if (missing.length)
    throw new ReportDeliveryError(
      `Set chief.reporting.destinations ${missing.map((field) => configNames[field]).join(", ")} in av.yaml and their environment variables; then retry av reports.`,
      true,
      false,
    )
}

export function multipartFile(request: ReportChannelRequest, field: string): FormData {
  if (!request.attachment || !request.bytes)
    throw new ReportDeliveryError(
      "No verified capture bytes were provided. Restore the capture and retry av reports.",
      true,
      false,
    )
  const form = new FormData()
  form.append(field, new Blob([request.bytes], { type: request.attachment.mimeType }), request.attachment.name)
  return form
}

export function createReportHttp(fetch: typeof globalThis.fetch) {
  async function request(url: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await fetch(httpsUrl(url), { ...options, signal, redirect: "error" })
    if (!response.ok) {
      const pending = response.status === 401 || response.status === 403
      throw new ReportDeliveryError(
        `Report provider returned HTTP ${response.status}. Check its credentials, permissions and upload limits, then retry av reports.`,
        pending,
        response.status === 408 || response.status === 429 || response.status >= 500,
      )
    }
    return response
  }
  async function object(response: Response): Promise<Record<string, unknown>> {
    try {
      const value: unknown = await response.json()
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
      return value as Record<string, unknown>
    } catch {
      throw new ReportDeliveryError(
        "Report provider did not confirm delivery. Check the destination API and retry av reports.",
        false,
        false,
      )
    }
  }
  async function json(
    url: string,
    body: unknown,
    signal: AbortSignal,
    token?: string,
  ): Promise<Record<string, unknown>> {
    return object(
      await request(
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        },
        signal,
      ),
    )
  }
  function confirmed(result: Record<string, unknown>, key = "ok"): void {
    if (key === "ok" ? result.ok !== true : typeof result[key] !== "string" || !result[key])
      throw new ReportDeliveryError(
        "Report provider rejected delivery. Check API scopes and channel access, then retry av reports.",
        true,
        false,
      )
  }
  return { request, object, json, confirmed }
}

export type ReportHttp = ReturnType<typeof createReportHttp>
