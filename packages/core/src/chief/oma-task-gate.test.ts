import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, describe, expect, test } from "vitest"
import type { Issue, RunAttempt, Workspace } from "../domain/models"
import type { OmaLatestCliIO } from "../oma/latest-cli"
import {
  OMA_RECEIPT_SCHEMA_VERSION,
  type OmaEvidenceRequest,
  parseOmaCliVersion,
  prepareOmaAttempt,
  validateOmaEvidence,
} from "../oma/receipt-adapter"
import { intermediateVerifyCommand } from "./runtime"

const installed = spawnSync("oma", ["--version"], { encoding: "utf-8", timeout: 5_000 })
const available = installed.status === 0 && !!parseOmaCliVersion(installed.stdout)
const required = !!process.env.CI && process.env.CI !== "false" && process.env.CI !== "0"
const latestCliIO: OmaLatestCliIO = {
  run: async (command, args) => {
    if (command === "oma") return { exitCode: installed.status, stdout: installed.stdout }
    if (command === "npm" && args[0] === "view")
      return { exitCode: 0, stdout: JSON.stringify(parseOmaCliVersion(installed.stdout)) }
    throw new Error("Native Chief task-gate fixtures must not install packages or contact the registry")
  },
}
const directories: string[] = []

function execute(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, { cwd, encoding: "utf-8", timeout: 10_000 })
  if (result.error) throw result.error
  return result
}

function run(command: string, args: string[], cwd: string): string {
  const result = execute(command, args, cwd)
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr || result.stdout}`)
  return result.stdout
}

function commit(root: string, message: string): void {
  run("git", ["add", "."], root)
  run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", message], root)
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "av-chief-oma-")))
  directories.push(root)
  mkdirSync(join(root, ".agents/hooks/core"), { recursive: true })
  writeFileSync(
    join(root, ".agents/hooks/core/triggers.json"),
    JSON.stringify({ workflows: {}, skills: {}, informationalPatterns: {}, excludedWorkflows: [] }),
  )
  writeFileSync(join(root, ".gitignore"), ".agents/state/\n.agents/results/\n")
  writeFileSync(join(root, "input.txt"), "Initial input\n")
  run("git", ["init", "-q"], root)
  run("git", ["config", "user.name", "Chief Director Fixture"], root)
  run("git", ["config", "user.email", "fixture@example.invalid"], root)
  run("git", ["config", "core.whitespace", "blank-at-eol,blank-at-eof,space-before-tab"], root)
  commit(root, "Initial fixture")
  const base = run("git", ["rev-parse", "HEAD"], root).trim()
  const attemptId = randomUUID()
  const request: OmaEvidenceRequest = {
    issue: { id: "fixture-issue", identifier: "ORDER-1", title: "Implement first stage" } as Issue,
    workspace: { path: root, issueId: "fixture-issue" } as Workspace,
    attempt: { id: attemptId, issueId: "fixture-issue", startedAt: new Date().toISOString() } as RunAttempt,
    agentId: "engineer",
    verifyCommand: await intermediateVerifyCommand(root),
    kind: "code",
  }
  await prepareOmaAttempt(request, { latestCliIO })
  const begin = JSON.parse(
    run("oma", ["agent", "begin", "engineer", attemptId, attemptId, "--project-root", root, "--workspace", root], root),
  ) as { runId: string; claimPath: string }
  return { root, base, request, begin }
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Native receipt and Git commands only: no model calls or skill execution. */
describe.skipIf(!available && !required)(`chief intermediate OMA v${OMA_RECEIPT_SCHEMA_VERSION} gate`, () => {
  beforeAll(() => {
    if (!available)
      throw new Error(
        "CI requires the installed OMA CLI for native Chief task-gate tests. Run npm install -g oh-my-agent@latest and confirm oma --version is available on PATH.",
      )
  })
  test("accepts a committed partial task before a downstream goal artifact exists", async () => {
    const { root, base, request, begin } = await fixture()
    expect(request.verifyCommand).toBe(`git diff --check ${base} --`)
    writeFileSync(join(root, "input.txt"), "First stage implemented\n")
    commit(root, "Deliver first stage")
    expect(execute("sh", ["-c", "test -s downstream.txt"], root).status).toBe(1)
    const checks = JSON.parse(run("oma", ["agent", "verify", begin.runId, "--required", "--project-root", root], root))
    expect(checks).toMatchObject([{ checkId: "valley-verify", exitCode: 0 }])
    writeFileSync(
      begin.claimPath,
      JSON.stringify({ status: "completed", changedFiles: ["input.txt"], unresolved: [], artifacts: [] }),
    )
    const receipt = JSON.parse(
      run("oma", ["agent", "finish", begin.runId, begin.claimPath, "--project-root", root], root),
    )
    expect(receipt).toMatchObject({ status: "completed", exitCode: 0 })
    request.attempt.finishedAt = new Date().toISOString()
    expect(validateOmaEvidence(request)).toEqual({ ok: true, runId: begin.runId })
    expect(execute("sh", ["-c", "test -s downstream.txt"], root).status).toBe(1)
  }, 25_000)

  test.each([
    ["trailing whitespace", "First stage implemented   \n"],
    ["conflict markers", "<<<<<<< first\nleft\n=======\nright\n>>>>>>> second\n"],
  ])(
    "rejects committed %s using the saved task baseline",
    async (_name, content) => {
      const { root, request, begin } = await fixture()
      writeFileSync(join(root, "input.txt"), content)
      commit(root, "Commit broken first stage")
      // An unbounded check would inspect an empty working diff after the required commit.
      expect(execute("git", ["diff", "--check"], root).status).toBe(0)
      expect(execute("sh", ["-c", request.verifyCommand], root).status).not.toBe(0)
      execute("oma", ["agent", "verify", begin.runId, "--required", "--project-root", root], root)
      const { checks } = JSON.parse(
        readFileSync(join(root, ".agents/state/agent-runs", `${begin.runId}.json`), "utf8"),
      ) as { checks: { checkId: string; exitCode: number }[] }
      expect(checks[0]?.checkId).toBe("valley-verify")
      expect(checks[0]?.exitCode).not.toBe(0)
      writeFileSync(
        begin.claimPath,
        JSON.stringify({ status: "completed", changedFiles: ["input.txt"], unresolved: [], artifacts: [] }),
      )
      execute("oma", ["agent", "finish", begin.runId, begin.claimPath, "--project-root", root], root)
      request.attempt.finishedAt = new Date().toISOString()
      expect(validateOmaEvidence(request).ok).toBe(false)
    },
    25_000,
  )
})
