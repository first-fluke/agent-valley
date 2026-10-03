import { join } from "node:path"
import type { ReportChannelRequest } from "../domain/ports/report-channel"
import { createReportChannelRegistry } from "./report-delivery-adapters"
import {
  MAX_REPORT_ATTACHMENTS,
  type ReportDeliveryDependencies,
  ReportDeliveryError,
  type ReportDeliveryPolicy,
  type ReportDeliveryReceipt,
  type ReportDestination,
  type ResolvedReportDeliveryPolicy,
  reportAttachmentSchema,
  reportDeliveryPolicySchema,
} from "./report-delivery-contract"
import { resolveReportDestination } from "./report-delivery-http"
import {
  type OutboxRecord,
  ReportOutbox,
  readReportAttachment,
  receipt,
  reportChunks,
  sha256,
  validateReportAttachment,
} from "./report-delivery-outbox"
import type { Mission } from "./types"

export type { ReportChannelPort, ReportChannelRequest } from "../domain/ports/report-channel"
export { createReportChannelRegistry } from "./report-delivery-adapters"
export type {
  ReportAttachment,
  ReportChannelRegistry,
  ReportDeliveryDependencies,
  ReportDeliveryPolicy,
  ReportDeliveryReceipt,
  ReportDestination,
} from "./report-delivery-contract"
export { reportAttachmentSchema, reportDeliveryPolicySchema, reportDestinationSchema } from "./report-delivery-contract"

function dependencies(stateDir: string, overrides: Partial<ReportDeliveryDependencies>): ReportDeliveryDependencies {
  const fetch = overrides.fetch ?? globalThis.fetch
  return {
    fetch,
    env: overrides.env ?? process.env,
    registry: { ...createReportChannelRegistry(fetch), ...overrides.registry },
    attachments: overrides.attachments ?? [],
    artifactRoot: overrides.artifactRoot ?? join(stateDir, "captures"),
    now: overrides.now ?? (() => new Date()),
  }
}

function redact(text: string, policy: ResolvedReportDeliveryPolicy, env: Record<string, string | undefined>): string {
  const secrets = policy.destinations
    .flatMap((destination) =>
      Object.entries(destination)
        .filter(([key]) => key.endsWith("_env"))
        .map(([, name]) => env[name]),
    )
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length)
  for (const secret of new Set(secrets)) text = text.split(secret).join("[redacted]")
  return text
}

/** Queue first, then fan out independently. Delivery never changes the mission's business outcome. */
export async function dispatchMissionReport(
  mission: Mission,
  reportMarkdown: string,
  reportPath: string,
  config: ReportDeliveryPolicy | undefined,
  stateDir: string,
  overrides: Partial<ReportDeliveryDependencies> = {},
): Promise<ReportDeliveryReceipt[]> {
  if (!config || (mission.status !== "completed" && mission.status !== "failed")) return []
  const policy = reportDeliveryPolicySchema.parse(config)
  if (!policy.events.includes(mission.status)) return []
  const deps = dependencies(stateDir, overrides)
  const attachments = reportAttachmentSchema.array().max(MAX_REPORT_ATTACHMENTS).parse(deps.attachments)
  const markdown = redact(reportMarkdown, policy, deps.env)
  const reportHash = sha256(
    JSON.stringify([reportMarkdown, attachments.map(({ sha256: hash, name, mimeType }) => ({ hash, name, mimeType }))]),
  )
  const parts = reportChunks(markdown).length + attachments.length
  const outbox = new ReportOutbox(stateDir)
  const records = policy.destinations.map(
    (destination): OutboxRecord => ({
      version: 1,
      id: sha256(JSON.stringify([mission.id, mission.status, reportHash, destination.id])),
      missionId: mission.id,
      missionStatus: mission.status as "completed" | "failed",
      destinationId: destination.id,
      channel: destination.channel,
      reportHash,
      goal: redact(mission.goal, policy, deps.env),
      markdown,
      reportPath: redact(reportPath, policy, deps.env),
      attachments,
      status: "pending",
      attempts: 0,
      nextPart: 0,
      parts,
      createdAt: deps.now().toISOString(),
      updatedAt: deps.now().toISOString(),
      message: "Report queued for delivery.",
    }),
  )
  return Promise.all(
    records.map((record, index) => processRecord(record, policy.destinations[index], policy, outbox, deps, false)),
  )
}

/** Replays stored reports and verified capture bytes through today's trusted config, without running Actors. */
export async function retryPendingReports(
  config: ReportDeliveryPolicy | undefined,
  stateDir: string,
  overrides: Partial<ReportDeliveryDependencies> = {},
): Promise<ReportDeliveryReceipt[]> {
  const outbox = new ReportOutbox(stateDir)
  const records = (await outbox.list()).filter((record) => record.status !== "delivered")
  if (!config) return records.map(receipt)
  const policy = reportDeliveryPolicySchema.parse(config)
  const deps = dependencies(stateDir, overrides)
  return Promise.all(
    records.map((record) =>
      processRecord(
        record,
        policy.destinations.find((destination) => destination.id === record.destinationId),
        policy,
        outbox,
        deps,
        true,
      ),
    ),
  )
}

export async function listReportDeliveries(stateDir: string): Promise<ReportDeliveryReceipt[]> {
  return (await new ReportOutbox(stateDir).list()).map(receipt)
}

async function processRecord(
  candidate: OutboxRecord,
  destination: ReportDestination | undefined,
  policy: ResolvedReportDeliveryPolicy,
  outbox: ReportOutbox,
  deps: ReportDeliveryDependencies,
  explicitRetry: boolean,
): Promise<ReportDeliveryReceipt> {
  let unlock: (() => Promise<void>) | undefined
  let record = candidate
  try {
    try {
      unlock = await outbox.lock(record.id)
    } catch {
      const saved = await outbox.load(record.id)
      return {
        ...receipt(saved ?? record),
        message:
          "Report is owned by another process or its lock needs recovery. Retry av reports after that process stops.",
      }
    }
    record = (await outbox.load(record.id)) ?? candidate
    if (record.status === "delivered" || (!explicitRetry && record.status === "failed")) return receipt(record)
    // Every transport sees a durable pending record before it can perform any external call.
    record.status = "pending"
    record.updatedAt = deps.now().toISOString()
    await outbox.save(record)
    if (!destination || !policy.events.includes(record.missionStatus)) {
      record.message =
        "Destination or report event is disabled. Restore chief.reporting in av.yaml and retry av reports."
      await outbox.save(record)
      return receipt(record)
    }
    const port = deps.registry[destination.channel]
    if (!port)
      throw new ReportDeliveryError(
        `Register the ${destination.channel} report channel adapter or select a supported channel in av.yaml, then retry av reports.`,
        true,
        false,
      )
    for (let attempt = 0; attempt < policy.max_attempts; attempt++) {
      try {
        const resolved = resolveReportDestination(destination, deps.env)
        const destinationHash = sha256(JSON.stringify([destination.channel, resolved]))
        if (record.destinationHash && record.destinationHash !== destinationHash) record.nextPart = 0
        record.destinationHash = destinationHash
        record.channel = destination.channel
        port.validate?.(resolved, record.attachments.length > 0)
        for (const attachment of record.attachments) await validateReportAttachment(attachment, deps.artifactRoot)
        record.status = "pending"
        record.message = "Report delivery in progress."
        record.attempts++
        await outbox.save(record)
        const chunks = reportChunks(record.markdown)
        while (record.nextPart < record.parts) {
          const attachment = record.attachments[record.nextPart - chunks.length]
          const part = record.nextPart + 1
          const text = `Agent Valley · ${record.missionId} · ${record.missionStatus} · ${part}/${record.parts}\n${attachment ? attachment.name : chunks[record.nextPart]}`
          const request: Omit<ReportChannelRequest, "signal"> = {
            report: {
              missionId: record.missionId,
              missionStatus: record.missionStatus,
              goal: record.goal,
              markdown: record.markdown,
              reportPath: record.reportPath,
              reportHash: record.reportHash,
              idempotencyKey: record.id,
            },
            destination: resolved,
            text,
            part,
            parts: record.parts,
            ...(attachment ? { attachment, bytes: await readReportAttachment(attachment, deps.artifactRoot) } : {}),
          }
          await boundedSend((signal) => port.send({ ...request, signal }), policy.timeout_ms)
          record.nextPart++
          record.updatedAt = deps.now().toISOString()
          await outbox.save(record)
        }
        record.status = "delivered"
        record.message = "Report and all capture attachments delivered."
        break
      } catch (error) {
        const failure = safeFailure(error)
        record.status = failure.pending ? "pending" : "failed"
        record.message = redact(failure.message, policy, deps.env).slice(0, 1_000)
        if (!failure.retryable) break
      }
    }
    record.updatedAt = deps.now().toISOString()
    await outbox.save(record)
    return receipt(record)
  } catch (error) {
    const failure = safeFailure(error)
    record.status = failure.pending ? "pending" : "failed"
    record.message = redact(failure.message, policy, deps.env).slice(0, 1_000)
    record.updatedAt = deps.now().toISOString()
    try {
      await outbox.save(record)
    } catch {
      record.message =
        "Report outbox cannot be written. Restore access to the Chief Director state directory, then retry report delivery."
    }
    return receipt(record)
  } finally {
    await unlock?.().catch(() => {})
  }
}

function safeFailure(error: unknown): ReportDeliveryError {
  return error instanceof ReportDeliveryError
    ? error
    : new ReportDeliveryError(
        "Report transport failed. Check the channel connection and credentials, then retry av reports.",
      )
}

async function boundedSend(send: (signal: AbortSignal) => Promise<void>, timeout: number): Promise<void> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      send(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new ReportDeliveryError("Report delivery timed out. Check the channel connection and retry av reports."),
          )
        }, timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
