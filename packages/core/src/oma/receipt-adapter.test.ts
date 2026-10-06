import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { projectConfigSchema } from "../config/yaml-loader"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { OmaLatestCliIO } from "./latest-cli"
import {
  buildOmaGuidance,
  OMA_RECEIPT_SCHEMA_VERSION,
  type OmaEvidenceIO,
  type OmaEvidenceRequest,
  parseOmaCliVersion,
  prepareOmaAttempt,
  validateOmaEvidence,
} from "./receipt-adapter"

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222"

const unavailableLatestIO: OmaLatestCliIO = {
  run: async () => {
    throw new Error("Unexpected registry access before trusted configuration validation")
  },
}

function strictRequest(root: string): OmaEvidenceRequest {
  const req = request()
  req.workspace.path = root
  const hooks = join(root, ".agents", "hooks", "core")
  mkdirSync(hooks, { recursive: true })
  writeFileSync(
    join(hooks, "triggers.json"),
    JSON.stringify({ workflows: {}, skills: {}, informationalPatterns: {}, excludedWorkflows: [] }),
  )
  return req
}

function request(kind: "code" | "analysis" = "code"): OmaEvidenceRequest {
  const issue = { id: "issue-1", identifier: "AV-1", title: "Fix bug" } as Issue
  const workspace = { path: "/tmp/target-worktree", issueId: issue.id } as Workspace
  const attempt = {
    id: ATTEMPT_ID,
    issueId: issue.id,
    startedAt: "2026-09-28T00:00:00.000Z",
    finishedAt: "2026-09-28T00:10:00.000Z",
  } as RunAttempt
  return {
    issue,
    workspace,
    attempt,
    agentId: "codex",
    verifyCommand: "npm test",
    kind,
    reportPath: kind === "analysis" ? ".agents/results/report-{{attempt.id}}.md" : undefined,
  }
}

function receipt(req: OmaEvidenceRequest): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    sequence: 1,
    taskId: req.attempt.id,
    sessionId: req.attempt.id,
    agentId: req.agentId,
    workspace: req.workspace.path,
    artifactRoot: req.workspace.path,
    startedAt: "2026-09-28T00:00:01.000Z",
    finishedAt: "2026-09-28T00:09:00.000Z",
    status: "completed",
    exitCode: 0,
    before: "a".repeat(64),
    after: "b".repeat(64),
    changedFiles: ["src/index.ts"],
    unresolved: [],
    artifacts: {
      [req.reportPath?.replaceAll("{{attempt.id}}", req.attempt.id) ?? ".agents/results/report.md"]: "c".repeat(64),
    },
    contract: { required_checks: [{ id: "valley-verify", command: ["sh", "-c", req.verifyCommand], cwd: "." }] },
    checks: [
      {
        checkId: "valley-verify",
        command: ["sh", "-c", req.verifyCommand],
        cwd: req.workspace.path,
        exitCode: 0,
        before: "b".repeat(64),
        after: "b".repeat(64),
      },
    ],
  }
}

function fakeIO(run: Record<string, unknown> | null, status = "codex:completed", version = "15.7.1"): OmaEvidenceIO {
  return {
    listRunFiles: () => (run ? [`${RUN_ID}.json`] : []),
    readReceipt: () => JSON.stringify(run),
    runCli: (args) =>
      args[0] === "--version" ? { exitCode: 0, stdout: `${version}\n` } : { exitCode: 0, stdout: `${status}\n` },
  }
}

describe("OMA receipt adapter", () => {
  test("configuration accepts explicit strict mode and rejects unknown modes", () => {
    expect(projectConfigSchema.safeParse({ oma: { mode: "strict" } }).success).toBe(true)
    expect(projectConfigSchema.safeParse({ oma: { mode: "best-effort" } }).success).toBe(false)
  })
  test("accepts current code evidence bound to the exact attempt", () => {
    const req = request()
    const io = fakeIO(receipt(req))
    const calls: string[][] = []
    const original = io.runCli
    io.runCli = (args, cwd) => {
      calls.push(args)
      return original(args, cwd)
    }
    expect(validateOmaEvidence(req, io)).toEqual({ ok: true, runId: RUN_ID })
    expect(calls.at(-1)).toEqual(["agent", "status", ATTEMPT_ID, "codex", "--project-root", req.workspace.path])
  })

  test("accepts analysis only with a bound report artifact", () => {
    const req = request("analysis")
    const run = { ...receipt(req), before: "b".repeat(64), changedFiles: [] }
    expect(validateOmaEvidence(req, fakeIO(run)).ok).toBe(true)
    expect(validateOmaEvidence(req, fakeIO({ ...run, artifacts: {} })).ok).toBe(false)
    expect(
      validateOmaEvidence(
        req,
        fakeIO({
          ...run,
          artifacts: { ".agents/results/unrelated.md": "c".repeat(64) },
        }),
      ).ok,
    ).toBe(false)
  })

  test.each([
    ["missing", () => null],
    ["wrong workspace", (run: Record<string, unknown>) => ({ ...run, workspace: "/tmp/another-worktree" })],
    ["wrong attempt", (run: Record<string, unknown>) => ({ ...run, taskId: "another-attempt" })],
    ["stale timestamp", (run: Record<string, unknown>) => ({ ...run, startedAt: "2026-09-27T23:59:00.000Z" })],
    ["failed", (run: Record<string, unknown>) => ({ ...run, status: "failed" })],
    ["unresolved", (run: Record<string, unknown>) => ({ ...run, unresolved: ["tests failed"] })],
    [
      "failed check",
      (run: Record<string, unknown>) => ({
        ...run,
        checks: [{ ...(run.checks as Record<string, unknown>[])[0], exitCode: 1 }],
      }),
    ],
    [
      "stale check",
      (run: Record<string, unknown>) => ({
        ...run,
        checks: [{ ...(run.checks as Record<string, unknown>[])[0], after: "d".repeat(64) }],
      }),
    ],
    ["no changed inputs", (run: Record<string, unknown>) => ({ ...run, before: run.after })],
  ] as const)("rejects %s evidence", (_case, mutate) => {
    const req = request()
    const run = mutate(receipt(req))
    expect(validateOmaEvidence(req, fakeIO(run)).ok).toBe(false)
  })

  test("fails closed when OMA reports stale evidence or an unknown status format", () => {
    const req = request()
    const run = receipt(req)
    expect(validateOmaEvidence(req, fakeIO(run, "codex:stale")).ok).toBe(false)
    expect(validateOmaEvidence(req, fakeIO(run, "status completed")).ok).toBe(false)
  })

  test("rejects a failed additional check even when the required check passed", () => {
    const req = request()
    const run = receipt(req)
    run.checks = [
      ...(run.checks as Record<string, unknown>[]),
      {
        command: ["sh", "-c", "extra check"],
        cwd: req.workspace.path,
        exitCode: 1,
        before: run.after,
        after: run.after,
      },
    ]
    expect(validateOmaEvidence(req, fakeIO(run)).ok).toBe(false)
  })

  test.each(["15.7.1", "15.7.2", "15.8.0", "16.0.0", "17.0.0-rc.1+build.2"])(
    "accepts actual v1 evidence from OMA %s without a release pin",
    (version) => {
      const req = request()
      expect(validateOmaEvidence(req, fakeIO(receipt(req), "codex:completed", version))).toEqual({
        ok: true,
        runId: RUN_ID,
      })
    },
  )

  test.each(["", "latest", "OMA 16.0.0", "16.0", "16.0.0\nextra output", "016.0.0", "16.0.0-01"])(
    "fails closed on malformed CLI version %j",
    (version) => {
      const req = request()
      expect(parseOmaCliVersion(version)).toBeNull()
      expect(validateOmaEvidence(req, fakeIO(receipt(req), "codex:completed", version))).toMatchObject({
        ok: false,
        reason: expect.stringContaining("oh-my-agent@latest"),
      })
    },
  )

  test("normalizes native semantic version output without claiming protocol compatibility", () => {
    expect(parseOmaCliVersion("16.0.0\n")).toBe("16.0.0")
    expect(parseOmaCliVersion("16.0.0-beta.1+abc.00")).toBe("16.0.0-beta.1+abc.00")
  })

  test.each([2, undefined, "1"])("rejects incompatible receipt schema %j even from a newer CLI", (schemaVersion) => {
    const req = request()
    const actual = receipt(req)
    expect(actual.schemaVersion).toBe(OMA_RECEIPT_SCHEMA_VERSION)
    actual.schemaVersion = schemaVersion
    expect(validateOmaEvidence(req, fakeIO(actual, "codex:completed", "16.0.0"))).toMatchObject({
      ok: false,
      reason: expect.stringContaining("OMA CLI 16.0.0 returned an unsupported receipt schema"),
    })
  })

  test("does not infer native completion proof from a newer CLI's JSON status", () => {
    const req = request()
    expect(
      validateOmaEvidence(req, fakeIO(receipt(req), '{"agent":"codex","status":"completed"}', "16.0.0")),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("unknown status output cannot establish completion") })
  })

  test("rejects malformed receipt JSON and absent CLI", () => {
    const req = request()
    const malformed = fakeIO(receipt(req))
    malformed.readReceipt = () => "{broken"
    expect(validateOmaEvidence(req, malformed).ok).toBe(false)
    const absent = fakeIO(receipt(req))
    absent.runCli = () => {
      throw new Error("ENOENT")
    }
    expect(validateOmaEvidence(req, absent).ok).toBe(false)
  })

  test("writes trusted required checks and guidance for the exact attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "av-oma-plan-"))
    try {
      const req = strictRequest(root)
      let installedVersion = "15.7.1"
      const readiness = vi.fn<OmaLatestCliIO["run"]>(async (command, args) => {
        expect(existsSync(join(root, ".agents", "results", `plan-${req.attempt.id}.json`))).toBe(false)
        if (command === "oma") return { exitCode: 0, stdout: installedVersion }
        if (args[0] === "view") return { exitCode: 0, stdout: JSON.stringify("15.7.2") }
        if (args[0] === "install") {
          installedVersion = "15.7.2"
          return { exitCode: 0, stdout: "" }
        }
        throw new Error("Unexpected readiness command")
      })
      const path = await prepareOmaAttempt(req, { latestCliIO: { run: readiness } })
      expect(readiness.mock.calls.some(([command, args]) => command === "npm" && args[0] === "install")).toBe(true)
      const plan = JSON.parse(readFileSync(path, "utf-8")) as {
        tasks: Array<{ required_checks: Array<{ command: string[] }> }>
      }
      expect(plan.tasks[0]?.required_checks[0]?.command).toEqual(["sh", "-c", "npm test"])
      expect(buildOmaGuidance(req)).toContain(ATTEMPT_ID)
      expect(buildOmaGuidance(req)).toContain("--project-root")
      expect(buildOmaGuidance(req)).not.toContain("--root ")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("leaves the strict attempt unprepared when fresh latest readiness fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "av-oma-unavailable-latest-"))
    try {
      const req = strictRequest(root)
      await expect(prepareOmaAttempt(req, { latestCliIO: unavailableLatestIO })).rejects.toThrow()
      expect(existsSync(join(root, ".agents", "results", `plan-${req.attempt.id}.json`))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("strict preparation rejects a missing or incompatible target-workspace trigger table", async () => {
    const root = mkdtempSync(join(tmpdir(), "av-oma-missing-table-"))
    try {
      const req = request()
      req.workspace.path = root
      await expect(prepareOmaAttempt(req, { latestCliIO: unavailableLatestIO })).rejects.toThrow("target worktree")
      const hooks = join(root, ".agents", "hooks", "core")
      mkdirSync(hooks, { recursive: true })
      writeFileSync(join(hooks, "triggers.json"), JSON.stringify({ schemaVersion: 2, workflows: {} }))
      await expect(prepareOmaAttempt(req, { latestCliIO: unavailableLatestIO })).rejects.toThrow("target worktree")
      writeFileSync(
        join(hooks, "triggers.json"),
        JSON.stringify({
          workflows: { debug: { persistent: false, keywords: { en: ["fix bug"] } } },
          skills: {},
          informationalPatterns: {},
          excludedWorkflows: [],
        }),
      )
      await expect(prepareOmaAttempt(req, { latestCliIO: unavailableLatestIO })).rejects.toThrow(
        "workflow file missing",
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
