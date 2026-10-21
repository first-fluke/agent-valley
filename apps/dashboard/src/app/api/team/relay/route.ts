import { publishTeamEvent, readTeamEvents } from "@/lib/team-gateway-service"

export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return readTeamEvents(request)
}

export async function POST(request: Request): Promise<Response> {
  return publishTeamEvent(request)
}
