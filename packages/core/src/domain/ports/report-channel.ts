export interface ReportAttachment {
  path: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface ReportEnvelope {
  missionId: string
  missionStatus: "completed" | "failed"
  goal: string
  markdown: string
  reportPath: string
  reportHash: string
  idempotencyKey: string
}

/** Resolved secrets exist only during a delivery attempt. Never serialize this object. */
export interface ResolvedReportDestination {
  url?: string
  token?: string
  chatId?: string
  channelId?: string
  space?: string
  teamId?: string
  driveId?: string
  baseUrl?: string
}

export interface ReportChannelRequest {
  report: ReportEnvelope
  destination: ResolvedReportDestination
  text: string
  part: number
  parts: number
  attachment?: ReportAttachment
  bytes?: Uint8Array<ArrayBuffer>
  signal: AbortSignal
}

export interface ReportChannelPort {
  validate?(destination: ResolvedReportDestination, hasAttachments: boolean): void
  send(request: ReportChannelRequest): Promise<void>
}

export type ReportChannelRegistry = Readonly<Record<string, ReportChannelPort>>
