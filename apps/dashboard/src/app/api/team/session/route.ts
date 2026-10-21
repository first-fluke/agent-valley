import { readTeamSession } from "@/lib/team-gateway-service"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return readTeamSession(request)
}
