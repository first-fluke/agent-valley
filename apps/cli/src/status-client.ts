import { dashboardTargetHost } from "./webhook-proxy"

/** Absolute URL of a dashboard API path on the locally running dashboard. */
export function dashboardUrl(port: string, path: string): string {
  const targetHost = dashboardTargetHost()
  const host = targetHost.includes(":") ? `[${targetHost}]` : targetHost
  return `http://${host}:${port}${path}`
}

export async function readStatus(port: string): Promise<Record<string, unknown>> {
  const token = process.env.SYMPHONY_DASHBOARD_TOKEN
  const response = await fetch(dashboardUrl(port, "/api/status"), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Dashboard denied status (${response.status}). Set SYMPHONY_DASHBOARD_TOKEN in your environment to match the dashboard process.`,
      )
    }
    throw new Error(`Dashboard status request failed (${response.status}).`)
  }
  return (await response.json()) as Record<string, unknown>
}
