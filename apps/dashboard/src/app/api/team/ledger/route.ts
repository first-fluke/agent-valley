import { authorizeStatusRequest } from "@/lib/dashboard-auth"
import { toOrchestratorConfig } from "@/lib/env"
import { resolveProjectRoot } from "@/lib/project-root"
import { readTeamLedger } from "@/lib/team-ledger-service"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  const denied = authorizeStatusRequest(request)
  if (denied) return denied

  try {
    const config = toOrchestratorConfig(await resolveProjectRoot(process.cwd()))
    const result = await readTeamLedger(config)
    const status = result.mode === "team" && result.status === "error"
      ? result.code === "team_access_denied" ? 403
        : ["missing_session", "session_expired", "session_mismatch"].includes(result.code) ? 401
          : 503
      : 200
    return Response.json(result, { status, headers: { "Cache-Control": "no-store" } })
  } catch {
    return Response.json(
      { mode: "team", status: "error", code: "config_unavailable", message: "Dashboard configuration could not be loaded. Check valley.yaml and settings.yaml." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    )
  }
}
