/**
 * Integration test helpers — shared scaffolding for end-to-end flow tests.
 *
 * Integration tests exercise the real Orchestrator + LinearWebhookReceiver +
 * WorkspaceManager (backed by a real temp git repo) with fakes only at the
 * Tracker + AgentSession seams so every other wire stays live.
 *
 * Design: v0.2 M3 — integration coverage for todo→done, retry exhaustion,
 * and intervention flow. Tests run in-process with no sockets.
 */

import { execSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Config } from "../../config/yaml-loader"
import type { Issue } from "../../domain/models"
import { Orchestrator } from "../../orchestrator/orchestrator"
import { LinearWebhookReceiver } from "../../tracker/adapters/linear-webhook-receiver"
import { FileSystemWorkspaceGateway } from "../../workspace/adapters/fs-workspace-gateway"
import { WorkspaceManager } from "../../workspace/workspace-manager"
import { makeConfig } from "../characterization/helpers"
import { FakeIssueTracker } from "../fakes/fake-tracker"

// ── HMAC helper — matches LinearWebhookReceiver verification ──────────
export async function signPayload(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ])
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload))
  return Buffer.from(sig).toString("hex")
}

export function makeIssuePayload(
  config: Config,
  overrides: {
    id: string
    identifier: string
    title?: string
    description?: string
    toState: "todo" | "inProgress" | "done" | "cancelled"
    fromState?: "todo" | "inProgress" | "done" | "cancelled"
  },
): string {
  const stateMap = config.workflowStates
  const base: Record<string, unknown> = {
    type: "Issue",
    action: "update",
    data: {
      id: overrides.id,
      identifier: overrides.identifier,
      title: overrides.title ?? "feat: integration",
      description: overrides.description ?? "",
      url: `https://linear.app/test/issue/${overrides.identifier}`,
      state: {
        id: stateMap[overrides.toState],
        name: overrides.toState,
        type: overrides.toState === "todo" ? "unstarted" : "started",
      },
      team: { id: "team-uuid", key: "PROJ" },
    },
  }
  if (overrides.fromState) {
    base.updatedFrom = { stateId: stateMap[overrides.fromState] }
  }
  return JSON.stringify(base)
}

// ── Real git temp repo scaffolding ─────────────────────────────────────

export interface RepoHandle {
  repoDir: string
  run: (cmd: string, cwd?: string) => string
  cleanup: () => Promise<void>
}

export async function createGitRepo(): Promise<RepoHandle> {
  const repoDir = await mkdtemp(join(tmpdir(), "av-integ-"))
  const run = (args: string, cwd?: string): string =>
    execSync(`git ${args}`, { cwd: cwd ?? repoDir, encoding: "utf-8" }).trim()

  run("init -b main")
  run("config user.email integ@test.local")
  run("config user.name IntegTest")
  // Keep local pushes from needing a configured remote during tests.
  run("config receive.denyCurrentBranch updateInstead")

  await writeFile(join(repoDir, "README.md"), "# integ\n")
  run("add .")
  run("commit -m 'initial commit'")

  return {
    repoDir,
    run,
    cleanup: () => rm(repoDir, { recursive: true, force: true }),
  }
}

// ── Orchestrator wiring with swappable tracker + real workspace ───────

export interface OrchestratorRig {
  orchestrator: Orchestrator
  tracker: FakeIssueTracker
  webhook: LinearWebhookReceiver
  workspaceRoot: string
  config: Config
  /** Send a signed webhook the same way the HTTP route would. */
  post: (payload: string) => Promise<{ status: number; body: string }>
  stop: () => Promise<void>
}

export interface RigOverrides {
  workspaceRoot: string
  overrides?: Partial<Config>
  tracker?: FakeIssueTracker
}

/**
 * Build a full orchestrator pipeline whose only fakes are the tracker +
 * agent sessions (registered separately by the caller). The webhook
 * receiver, workspace gateway, and git command path are all live.
 */
export function buildOrchestratorRig(opts: RigOverrides): OrchestratorRig {
  const config = makeConfig({ ...opts.overrides, workspaceRoot: opts.workspaceRoot })
  const tracker = opts.tracker ?? new FakeIssueTracker()
  const webhook = new LinearWebhookReceiver({
    secret: config.linearWebhookSecret,
    workflowStates: config.workflowStates,
  })
  const gateway = new FileSystemWorkspaceGateway(new WorkspaceManager(config.workspaceRoot))
  const orchestrator = new Orchestrator(config, tracker, webhook, gateway)

  const { onWebhook } = orchestrator.getHandlers()
  const post = async (payload: string) => {
    const sig = await signPayload(payload, config.linearWebhookSecret)
    return onWebhook(payload, sig)
  }

  return {
    orchestrator,
    tracker,
    webhook,
    workspaceRoot: opts.workspaceRoot,
    config,
    post,
    stop: async () => {
      await orchestrator.stop().catch(() => undefined)
    },
  }
}

/** Wait until `predicate()` returns truthy or `timeoutMs` elapses. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  opts: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const timeout = opts.timeoutMs ?? 2_000
  const step = opts.intervalMs ?? 20
  const label = opts.description ?? "condition"
  const deadline = Date.now() + timeout
  let lastValue: T | undefined
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    lastValue = value
    await new Promise((r) => setTimeout(r, step))
  }
  throw new Error(
    `waitFor: timed out after ${timeout}ms waiting for ${label}.\n` +
      `  Last value: ${String(lastValue)}.\n` +
      `  Fix: increase timeoutMs or inspect the fake state you are asserting on.`,
  )
}

export function makeIssueFromPayloadId(id: string, identifier: string): Issue {
  return {
    id,
    identifier,
    title: "feat: integration",
    description: "",
    status: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-uuid", key: "PROJ" },
    labels: [],
    url: `https://linear.app/test/issue/${identifier}`,
    score: null,
    parentId: null,
    children: [],
    relations: [],
  }
}
