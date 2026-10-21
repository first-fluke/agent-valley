import { z } from "zod"
import { AGENT_TYPES } from "../domain/ledger"

export const teamIdSchema = z.uuid()
export const eventIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/)
const text = z.string().trim().min(1).max(2_000)
const timestamp = z.iso.datetime({ offset: true })
const agentType = z.enum(AGENT_TYPES)
const envelope = { nodeId: text, clientTimestamp: timestamp }
const payloads = {
  "node.join": z.object({ defaultAgentType: agentType, maxParallel: z.number().int().positive(), displayName: text }),
  "node.reconnect": z.object({ lastSeq: z.number().int().nonnegative().safe() }),
  "node.leave": z.object({ reason: z.enum(["graceful", "crash", "timeout"]) }),
  "agent.start": z.object({ agentType, issueKey: text, issueId: text }),
  "agent.done": z.object({ issueKey: text, issueId: text, durationMs: z.number().finite().nonnegative() }),
  "agent.failed": z.object({
    issueKey: text,
    issueId: text,
    error: z.object({ code: text, message: z.string().max(32_000), retryable: z.boolean() }),
  }),
  "agent.cancelled": z.object({ issueKey: text, issueId: text, reason: text }),
}

export const publishableEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...envelope, type: z.literal("node.join"), payload: payloads["node.join"] }),
  z.strictObject({ ...envelope, type: z.literal("node.reconnect"), payload: payloads["node.reconnect"] }),
  z.strictObject({ ...envelope, type: z.literal("node.leave"), payload: payloads["node.leave"] }),
  z.strictObject({ ...envelope, type: z.literal("agent.start"), payload: payloads["agent.start"] }),
  z.strictObject({ ...envelope, type: z.literal("agent.done"), payload: payloads["agent.done"] }),
  z.strictObject({ ...envelope, type: z.literal("agent.failed"), payload: payloads["agent.failed"] }),
  z.strictObject({ ...envelope, type: z.literal("agent.cancelled"), payload: payloads["agent.cancelled"] }),
])
export type PublishableEvent = z.infer<typeof publishableEventSchema>

export const ledgerEventSchema = z
  .strictObject({
    v: z.literal(1),
    seq: z.number().int().positive().safe(),
    relayTimestamp: timestamp,
    ...envelope,
    type: z.enum(Object.keys(payloads) as [keyof typeof payloads, ...(keyof typeof payloads)[]]),
    payload: z.unknown(),
  })
  .transform((event, ctx) => {
    const parsed = publishableEventSchema.safeParse({
      type: event.type,
      nodeId: event.nodeId,
      clientTimestamp: event.clientTimestamp,
      payload: event.payload,
    })
    if (!parsed.success) {
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
      return z.NEVER
    }
    return { ...parsed.data, v: event.v, seq: event.seq, relayTimestamp: event.relayTimestamp }
  })

export const teamIdentitySchema = z.strictObject({
  userId: z.uuid(),
  teamId: teamIdSchema,
  displayName: z.string().trim().min(1).max(200),
  role: z.enum(["owner", "admin", "member"]),
  expiresAt: z.number().int().positive().safe(),
})
export type TeamIdentity = z.infer<typeof teamIdentitySchema>
export const teamSessionResponseSchema = z.strictObject({ identity: teamIdentitySchema })
export const teamEventsResponseSchema = z.strictObject({ events: z.array(ledgerEventSchema).max(1_000) })
export const teamPublishRequestSchema = z.strictObject({
  teamId: teamIdSchema,
  eventId: eventIdSchema,
  event: publishableEventSchema,
})
export const teamPublishResponseSchema = z.strictObject({ ok: z.literal(true) })
