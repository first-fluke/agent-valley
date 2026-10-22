import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { z } from "zod"
import type { RunAttempt } from "../../domain/models"
import type { SpawnInput } from "../../domain/ports/agent-runner"

/** A2A specification 1.0.1 uses protocol version 1.0 on the wire. */
export const A2A_PROTOCOL_VERSION = "1.0"

export const a2aEndpointSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/),
    url: z.string().url(),
    agentCardUrl: z.string().url().optional(),
    authTokenEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]{0,127}$/)
      .optional(),
    tenant: z.string().min(1).max(2_000).optional(),
    requestTimeoutMs: z.number().int().min(10).max(300_000).optional(),
    pollIntervalMs: z.number().int().min(1).max(60_000).optional(),
    maxResponseBytes: z
      .number()
      .int()
      .min(256)
      .max(16 * 1_024 * 1_024)
      .optional(),
    /** Explicit development permission; only literal loopback addresses are accepted. */
    allowHttpLoopback: z.boolean().optional(),
  })
  .superRefine((endpoint, context) => {
    let origin: string | undefined
    for (const key of ["url", "agentCardUrl"] as const) {
      const value = endpoint[key]
      if (!value) continue
      const parsed = URL.canParse(value) ? new URL(value) : undefined
      if (!parsed) continue
      const local = ["127.0.0.1", "[::1]"].includes(parsed.hostname)
      if (
        (parsed.protocol !== "https:" && !(endpoint.allowHttpLoopback && parsed.protocol === "http:" && local)) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        context.addIssue({
          code: "custom",
          path: [key],
          message:
            "Use HTTPS without URL credentials, query or fragment; explicitly enabled HTTP development endpoints require a literal loopback address.",
        })
      if (key === "url") origin = parsed.origin
      else if (origin !== parsed.origin)
        context.addIssue({ code: "custom", path: [key], message: "Agent Card must use the pinned endpoint origin." })
    }
  })
export type A2aEndpoint = z.infer<typeof a2aEndpointSchema>

export const a2aTaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
])
export type A2aTaskState = z.infer<typeof a2aTaskStateSchema>
const identifier = z.string().min(1).max(2_000)
const metadata = z.record(z.string(), z.unknown())

export const a2aPartSchema = z
  .object({
    text: z.string().optional(),
    raw: z.string().optional(),
    url: z.string().optional(),
    data: z.unknown().optional(),
    metadata: metadata.optional(),
    filename: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .refine(
    (part) => ["text", "raw", "url", "data"].filter((key) => Object.hasOwn(part, key)).length === 1,
    "An A2A Part must contain exactly one of text, raw, url, or data.",
  )
export type A2aPart = z.infer<typeof a2aPartSchema>

export const a2aMessageSchema = z.object({
  messageId: identifier,
  contextId: identifier.optional(),
  taskId: identifier.optional(),
  role: z.enum(["ROLE_USER", "ROLE_AGENT"]),
  parts: z.array(a2aPartSchema).min(1).max(100),
  metadata: metadata.optional(),
  extensions: z.array(identifier).max(20).optional(),
})
export type A2aMessage = z.infer<typeof a2aMessageSchema>

export const a2aTaskSchema = z.object({
  id: identifier,
  contextId: identifier.optional(),
  status: z.object({
    state: a2aTaskStateSchema,
    message: a2aMessageSchema.optional(),
    timestamp: z.string().datetime({ offset: true }).optional(),
  }),
  artifacts: z
    .array(
      z.object({
        artifactId: identifier,
        name: z.string().optional(),
        description: z.string().optional(),
        parts: z.array(a2aPartSchema).min(1).max(100),
        metadata: metadata.optional(),
        extensions: z.array(identifier).max(20).optional(),
      }),
    )
    .max(100)
    .optional(),
  history: z.array(a2aMessageSchema).max(100).optional(),
  metadata: metadata.optional(),
})
export type A2aTask = z.infer<typeof a2aTaskSchema>

export const a2aSendResponseSchema = z
  .object({ task: a2aTaskSchema.optional(), message: a2aMessageSchema.optional() })
  .refine(
    (result) => Number(Boolean(result.task)) + Number(Boolean(result.message)) === 1,
    "SendMessage must return one task or message.",
  )
export type A2aSendResponse = z.infer<typeof a2aSendResponseSchema>

export const a2aCheckpointSchema = z.strictObject({
  version: z.literal(1),
  endpointId: identifier,
  endpointUrl: z.string().url(),
  attemptId: identifier,
  messageId: identifier,
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(["prepared", "submitting", "accepted", "terminal", "unknown"]),
  tenant: identifier.optional(),
  taskId: identifier.optional(),
  contextId: identifier.optional(),
  state: a2aTaskStateSchema.optional(),
})
export type A2aCheckpoint = z.infer<typeof a2aCheckpointSchema>

export interface A2aLifecycle {
  load(): Promise<A2aCheckpoint | undefined>
  save(checkpoint: A2aCheckpoint): Promise<void>
  /** The trusted AV gate verifies repository/artifact evidence before accepting output. */
  complete(response: A2aSendResponse, checkpoint: A2aCheckpoint): Promise<RunAttempt>
}
export type A2aLifecycleFactory = (input: SpawnInput) => A2aLifecycle

export function a2aRequestSha256(input: SpawnInput, endpoint: A2aEndpoint): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        attemptId: input.attemptId,
        issueId: input.issue.id,
        workspacePath: resolve(input.workspace.path),
        workspaceBranch: input.workspace.branch,
        agentType: input.agentType,
        model: input.model ?? null,
        prompt: input.prompt,
        endpointId: endpoint.id,
        endpointUrl: new URL(endpoint.url).href,
        tenant: endpoint.tenant ?? null,
      }),
    )
    .digest("hex")
}

export function isA2aTerminal(state: A2aTaskState): boolean {
  return ["TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED", "TASK_STATE_REJECTED"].includes(state)
}
