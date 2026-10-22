import { z } from "zod"
import type { SpawnInput } from "../domain/ports/agent-runner"
import { a2aCheckpointSchema, a2aEndpointSchema, a2aSendResponseSchema } from "../sessions/adapters/a2a-contracts"
import { a2aArtifactJournalSchema } from "./a2a-artifact"

const digest = z.string().regex(/^[a-f0-9]{64}$/)

export { a2aEndpointSchema }
export const a2aJobSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  root: z.string().min(1),
  repositoryId: digest,
  baseRevision: z.string().regex(/^[a-f0-9]{40,64}$/),
  baseFingerprint: digest,
  branch: z.string().min(1),
  endpoint: a2aEndpointSchema,
  goal: z.string().trim().min(1).max(64_000),
  prompt: z.string().min(1).max(128_000),
  requestSha256: digest,
  allowedPaths: z.array(z.string().min(1).max(512)).min(1).max(100),
  verifyCommand: z.string().trim().min(1).max(8_000),
  timeoutSec: z.number().int().min(1).max(86_400),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  status: z.enum(["pending", "running", "unknown", "verifying", "completed", "failed", "reconciled"]),
  checkpoint: a2aCheckpointSchema.optional(),
  response: a2aSendResponseSchema.optional(),
  artifact: a2aArtifactJournalSchema.optional(),
  verification: z
    .strictObject({
      ok: z.boolean(),
      command: z.string(),
      output: z.string().max(10_240),
      fingerprint: digest,
      at: z.iso.datetime(),
    })
    .optional(),
  result: z
    .strictObject({
      id: z.uuid(),
      issueId: z.uuid(),
      workspacePath: z.string(),
      startedAt: z.iso.datetime(),
      finishedAt: z.iso.datetime(),
      exitCode: z.number().int(),
      agentOutput: z.string().nullable(),
    })
    .optional(),
  error: z.string().max(4_000).optional(),
  reconciliation: z.strictObject({ evidence: z.string().trim().min(1).max(2_000), at: z.iso.datetime() }).optional(),
})
export type A2aJob = z.infer<typeof a2aJobSchema>

/** Reconstruct the identical request after a coordinator restart; credentials are never persisted. */
export function a2aJobInput(job: A2aJob, signal?: AbortSignal): SpawnInput {
  return {
    attemptId: job.id,
    attempt: {
      id: job.id,
      issueId: job.id,
      workspacePath: job.root,
      startedAt: job.createdAt,
      finishedAt: null,
      exitCode: null,
      agentOutput: null,
    },
    issue: {
      id: job.id,
      identifier: `A2A-${job.id}`,
      title: job.goal.slice(0, 200),
      description: job.goal,
      status: { id: "local", name: "In Progress", type: "started" },
      team: { id: "local", key: "A2A" },
      labels: [],
      url: "",
      score: null,
      parentId: null,
      children: [],
      relations: [],
    },
    workspace: {
      issueId: job.id,
      path: job.root,
      key: job.id,
      branch: job.branch,
      status: "running",
      createdAt: job.createdAt,
    },
    agentType: "a2a",
    prompt: job.prompt,
    timeoutMs: job.timeoutSec * 1_000,
    signal,
    stage: "work",
  }
}
