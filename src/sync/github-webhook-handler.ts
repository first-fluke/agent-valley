/**
 * GitHub Webhook Handler — Verify signatures and parse GitHub webhook events.
 * Infrastructure layer. No business logic.
 */

import { z } from "zod/v4"
import type { SyncEvent, SyncEventKind } from "../domain/models"
import { logger } from "../observability/logger"

const COMPONENT = "github-webhook-handler"

// ── Signature Verification ──────────────────────────────────────────

export async function verifyGitHubSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  const expected = "sha256=" + Buffer.from(sig).toString("hex")

  // Constant-time comparison
  if (expected.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}

// ── Payload Schemas ─────────────────────────────────────────────────

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    html_url: z.string(),
    merged: z.boolean().optional().default(false),
    head: z.object({
      ref: z.string(),
    }),
  }),
})

const checkSuitePayloadSchema = z.object({
  action: z.literal("completed"),
  check_suite: z.object({
    conclusion: z.string().nullable(),
    head_branch: z.string(),
    pull_requests: z.array(z.object({
      number: z.number(),
      url: z.string(),
    })),
  }),
})

// ── Issue Identifier Extraction ─────────────────────────────────────

const ISSUE_IDENTIFIER_PATTERN = /([A-Z]+-\d+)/i

function extractIssueIdentifier(branch: string): string | null {
  const match = branch.match(ISSUE_IDENTIFIER_PATTERN)
  return match ? match[1]!.toUpperCase() : null
}

// ── Event Parsing ───────────────────────────────────────────────────

export function parseGitHubWebhookEvent(
  payload: string,
  eventType: string,
): SyncEvent | null {
  try {
    const raw = JSON.parse(payload)

    if (eventType === "pull_request") {
      return parsePullRequestEvent(raw)
    }

    if (eventType === "check_suite") {
      return parseCheckSuiteEvent(raw)
    }

    logger.debug(COMPONENT, `Ignoring unsupported GitHub event type: ${eventType}`)
    return null
  } catch (err) {
    logger.error(COMPONENT, "Failed to parse GitHub webhook payload", {
      error: String(err),
      eventType,
    })
    return null
  }
}

function parsePullRequestEvent(raw: unknown): SyncEvent | null {
  const result = pullRequestPayloadSchema.safeParse(raw)
  if (!result.success) {
    logger.warn(COMPONENT, "Invalid pull_request payload", { error: result.error.message })
    return null
  }

  const { action, pull_request: pr } = result.data
  const issueIdentifier = extractIssueIdentifier(pr.head.ref)

  let kind: SyncEventKind
  if (action === "opened" || action === "reopened") {
    kind = "pr_opened"
  } else if (action === "closed" && pr.merged) {
    kind = "pr_merged"
  } else if (action === "closed") {
    kind = "pr_closed"
  } else {
    return null // Ignore other PR actions (labeled, assigned, etc.)
  }

  return {
    source: "github",
    kind,
    issueIdentifier,
    prNumber: pr.number,
    prTitle: pr.title,
    externalUrl: pr.html_url,
    detail: null,
    timestamp: new Date().toISOString(),
  }
}

function parseCheckSuiteEvent(raw: unknown): SyncEvent | null {
  const result = checkSuitePayloadSchema.safeParse(raw)
  if (!result.success) {
    logger.warn(COMPONENT, "Invalid check_suite payload", { error: result.error.message })
    return null
  }

  const { check_suite } = result.data

  // Only report failures
  if (check_suite.conclusion !== "failure") return null

  const issueIdentifier = extractIssueIdentifier(check_suite.head_branch)
  const prNumber = check_suite.pull_requests[0]?.number ?? null

  return {
    source: "github",
    kind: "check_suite_completed",
    issueIdentifier,
    prNumber,
    prTitle: null,
    externalUrl: check_suite.pull_requests[0]?.url ?? "",
    detail: `Check suite failed on branch ${check_suite.head_branch}`,
    timestamp: new Date().toISOString(),
  }
}
