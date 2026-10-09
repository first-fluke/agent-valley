import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, test } from "vitest"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { OmaLatestCliIO } from "./latest-cli"
import {
  createOmaEvidenceIO,
  OMA_RECEIPT_SCHEMA_VERSION,
  type OmaEvidenceRequest,
  parseOmaCliVersion,
  prepareOmaAttempt,
  validateOmaEvidence,
} from "./receipt-adapter"

const installed = spawnSync("oma", ["--version"], {
  env: { ...process.env, OMA_SKIP_VERSION_CHECK: "1" },
  encoding: "utf-8",
  timeout: 5_000,
})
const available = installed.status === 0 && !!parseOmaCliVersion(installed.stdout)
const required = !!process.env.CI && process.env.CI !== "false" && process.env.CI !== "0"
const latestCliIO: OmaLatestCliIO = {
  run: async (command, args) => {
    if (command === "oma") return { exitCode: installed.status, stdout: installed.stdout }
    if (command === "npm" && args[0] === "view")
      return { exitCode: 0, stdout: JSON.stringify(parseOmaCliVersion(installed.stdout)) }
    throw new Error("Native receipt fixtures must not install packages or contact the registry")
  },
}

function run(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf-8", timeout: 10_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`)
  return result.stdout
}

/** Uses only native receipt commands and local git; never invokes an agent or skill. */
describe.skipIf(!available && !required)(`OMA v${OMA_RECEIPT_SCHEMA_VERSION} native receipt contract`, () => {
  beforeAll(() => {
    if (!available)
      throw new Error(
        "CI requires the installed OMA CLI for native receipt contract tests. Run npm install -g oh-my-agent@latest and confirm oma --version is available on PATH.",
      )
  })
  test.each([
    { kind: "code", profile: "7", collision: false },
    { kind: "analysis", profile: "7", collision: false },
    { kind: "code", profile: "0", collision: true },
  ] as const)(
    "validates real $kind receipts in profile $profile and rejects modified evidence",
    async ({ kind, profile, collision }) => {
      const directory = realpathSync(mkdtempSync(join(tmpdir(), "av-oma-contract-")))
      const root = join(directory, "workspace")
      const env = {
        ...process.env,
        OMA_STATE_HOME: join(directory, "state"),
        OMA_PROFILE: profile,
        OMA_SKIP_VERSION_CHECK: "1",
      }
      const io = createOmaEvidenceIO({ env })
      mkdirSync(root)
      const attemptId = randomUUID()
      const report = `.agents/results/report-${attemptId}.md`
      const request: OmaEvidenceRequest = {
        issue: { id: "fixture-issue", identifier: "FIX-1", title: "Fixture" } as Issue,
        workspace: { path: root, issueId: "fixture-issue" } as Workspace,
        attempt: { id: attemptId, issueId: "fixture-issue", startedAt: new Date().toISOString() } as RunAttempt,
        agentId: "fixture",
        verifyCommand: `test -s ${kind === "code" ? "input.txt" : report}`,
        kind,
        reportPath: kind === "analysis" ? ".agents/results/report-{{attempt.id}}.md" : undefined,
      }
      try {
        mkdirSync(join(root, ".agents/hooks/core"), { recursive: true })
        writeFileSync(
          join(root, ".agents/hooks/core/triggers.json"),
          JSON.stringify({
            workflows: {},
            skills: {},
            informationalPatterns: {},
            excludedWorkflows: [],
          }),
        )
        writeFileSync(join(root, ".gitignore"), ".agents/state/\n.agents/results/\n")
        writeFileSync(join(root, "input.txt"), "before\n")
        run("git", ["init", "-q"], root)
        run("git", ["config", "user.name", "OMA Fixture"], root)
        run("git", ["config", "user.email", "fixture@example.invalid"], root)
        run("git", ["add", "."], root)
        run(
          "git",
          ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Initial fixture"],
          root,
        )
        await prepareOmaAttempt(request, { latestCliIO })
        const begin = JSON.parse(
          run(
            "oma",
            ["agent", "begin", request.agentId, attemptId, attemptId, "--project-root", root, "--workspace", root],
            root,
            env,
          ),
        ) as { runId: string; claimPath: string; schemaVersion: number }
        expect(begin.schemaVersion).toBe(1)
        if (kind === "code") {
          writeFileSync(join(root, "input.txt"), "after\n")
          run("git", ["add", "input.txt"], root)
          run(
            "git",
            ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "Update fixture"],
            root,
          )
        } else {
          writeFileSync(join(root, report), "Current attempt analysis\n")
        }
        const checks = JSON.parse(
          run("oma", ["agent", "verify", begin.runId, "--required", "--project-root", root], root, env),
        )
        expect(checks).toMatchObject([{ checkId: "valley-verify", exitCode: 0 }])
        writeFileSync(
          begin.claimPath,
          JSON.stringify({
            status: "completed",
            changedFiles: kind === "code" ? ["input.txt"] : [],
            unresolved: [],
            artifacts: kind === "analysis" ? [report] : [],
          }),
        )
        const receipt = JSON.parse(
          run("oma", ["agent", "finish", begin.runId, begin.claimPath, "--project-root", root], root, env),
        )
        expect(receipt).toMatchObject({ schemaVersion: 1, status: "completed", exitCode: 0 })
        request.attempt.finishedAt = new Date().toISOString()
        expect(
          run("oma", ["agent", "status", attemptId, request.agentId, "--project-root", root], root, env).trim(),
        ).toBe("fixture:completed")
        expect(validateOmaEvidence(request, io)).toEqual({ ok: true, runId: begin.runId })
        if (collision) {
          const legacy = join(root, ".agents", "state", "agent-runs")
          mkdirSync(legacy, { recursive: true })
          const runId = randomUUID()
          const path = join(legacy, `${runId}.json`)
          writeFileSync(path, JSON.stringify({ ...receipt, runId, sequence: receipt.sequence + 1 }))
          expect(
            run("oma", ["agent", "status", attemptId, request.agentId, "--project-root", root], root, env).trim(),
          ).toBe("fixture:completed")
          expect(validateOmaEvidence(request, io)).toMatchObject({
            ok: false,
            reason: expect.stringContaining("multiple stores"),
          })
          rmSync(path)
        }
        writeFileSync(join(root, kind === "code" ? "input.txt" : report), "Changed after verification\n")
        expect(validateOmaEvidence(request, io)).toMatchObject({
          ok: false,
          reason: "OMA CLI did not confirm current completed evidence",
        })
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
    25_000,
  )
})
