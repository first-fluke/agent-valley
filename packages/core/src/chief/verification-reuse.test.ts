import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearedGitEnvironment } from "../util/git-environment"
import { runCommand } from "../workspace/worktree-lifecycle"
import { workspaceFileManifest } from "./fingerprint"
import { fixture } from "./goal-supervision.fixture"
import {
  INTEGRATION_EVIDENCE_FILE_ENV,
  integrationEvidenceFor,
  readOperatorIntegrationEvidence,
  runIntegrationCheck,
} from "./runtime-integration-check"
import { MissionStore } from "./store"
import {
  executeGoalVerification,
  goalVerificationContractDigest,
  validateGoalVerificationContract,
} from "./verification"
import {
  buildVerificationBaseline,
  docOnlyRepairReuse,
  isDocOnlyPath,
  saveVerificationBaselineManifest,
} from "./verification-reuse"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-verify-reuse-"))
  roots.push(root)
  const git = async (...args: string[]) => {
    const res = await runCommand("git", args, { cwd: root, env: clearedGitEnvironment })
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
    return res.stdout
  }
  await git("init", "-q")
  await git("config", "user.email", "test@example.com")
  await git("config", "user.name", "Test")
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, body, "utf8")
  }
  await git("add", "-A")
  await git("commit", "-q", "-m", "init")
  await git("checkout", "-q", "-B", "chief/goal-mission")
  return root
}

describe("isDocOnlyPath", () => {
  it("allows conservative documentation paths", () => {
    expect(isDocOnlyPath("README.md")).toBe(true)
    expect(isDocOnlyPath("docs/qa-report.md")).toBe(true)
    expect(isDocOnlyPath("docs/architecture/guide.mdx")).toBe(true)
    expect(isDocOnlyPath("notes/summary.txt")).toBe(true)
  })

  it.each([
    "src/main.rs",
    "packages/core/src/chief/runtime.ts",
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "bun.lock",
    "scripts/check.sh",
    "docs/script.sh",
    ".github/workflows/ci.yml",
    ".github/README.md",
    ".agents/skills/oma-qa/SKILL.md",
    ".agent-valley/report.md",
    "tests/notes.md",
    "test/README.md",
    "docs/fixtures/sample.txt",
    "docs/testdata/case.md",
    "requirements.txt",
    "requirements-dev.txt",
    "CMakeLists.txt",
    "../outside.md",
    "/abs/README.md",
  ])("rejects non-doc or unsafe path %s", (path) => {
    expect(isDocOnlyPath(path)).toBe(false)
  })
})

describe("Part A: doc-only repair verification evidence reuse", () => {
  const successCriteria = ["Tests pass", "QA report is present"]
  const makeContract = (reportContains = "PASS") => ({
    version: 1 as const,
    criteria: [
      {
        criterion: "Tests pass",
        checks: [
          {
            kind: "command" as const,
            program: "node" as const,
            args: ["--test", "tests/app.test.mjs"],
            timeoutMs: 120_000,
          },
        ],
      },
      {
        criterion: "QA report is present",
        checks: [{ kind: "file" as const, path: "docs/qa-report.md", minBytes: 4, contains: [reportContains] }],
      },
    ],
  })

  it("reuses verified command evidence on doc-only repair while re-executing file checks fresh", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/qa-report.md": "Initial QA report: PASS\n",
    })
    const { mission } = fixture()
    mission.workspace.path = root
    mission.verificationContract = makeContract("UPDATED")
    mission.verificationContractSha256 = goalVerificationContractDigest(mission.verificationContract)

    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok 1\n", stderr: "" }))
    // Initial passing verification
    const initialContract = makeContract("PASS")
    mission.verificationContract = initialContract
    mission.verificationContractSha256 = goalVerificationContractDigest(initialContract)
    const firstResult = await executeGoalVerification(initialContract, root, {
      successCriteria,
      executeCommand,
    })
    expect(firstResult.ok).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(1)

    const initialManifest = await workspaceFileManifest(root)
    mission.goalVerification = firstResult
    mission.verification = { ok: true, fingerprint: initialManifest.fingerprint }
    mission.verificationBaseline = buildVerificationBaseline(firstResult, initialManifest.fingerprint)
    await saveVerificationBaselineManifest(root, initialManifest)

    // Doc-only repair: update docs/qa-report.md and add an untracked doc file docs/notes.txt
    await writeFile(join(root, "docs/qa-report.md"), "Updated QA report: PASS (FINAL)\n", "utf8")
    await writeFile(join(root, "docs/notes.txt"), "Extra reviewer notes\n", "utf8")

    const contract = validateGoalVerificationContract(initialContract, successCriteria)
    const reuse = await docOnlyRepairReuse(mission, contract)
    expect(reuse).toBeDefined()
    expect(reuse?.changedDocPaths).toEqual(["docs/notes.txt", "docs/qa-report.md"])
    expect(reuse?.checks).toHaveLength(1)

    const secondResult = await executeGoalVerification(initialContract, root, {
      successCriteria,
      executeCommand,
      reuse: reuse?.checks,
      reuseReason: reuse?.reuseReason,
    })
    expect(secondResult.ok).toBe(true)
    // Command check was NOT executed again!
    expect(executeCommand).toHaveBeenCalledTimes(1)
    expect(secondResult.evidence[0]?.checks[0]?.summary).toContain("only documentation files changed")
    // File check WAS re-executed against the new bytes
    expect(secondResult.evidence[1]?.checks[0]?.passed).toBe(true)

    // If the doc edit broke a file check (e.g. removed required text), file check catches it!
    await writeFile(join(root, "docs/qa-report.md"), "Incomplete wording\n", "utf8")
    const reuseAfterBrokenDoc = await docOnlyRepairReuse(mission, contract)
    expect(reuseAfterBrokenDoc).toBeDefined()
    const thirdResult = await executeGoalVerification(initialContract, root, {
      successCriteria,
      executeCommand,
      reuse: reuseAfterBrokenDoc?.checks,
      reuseReason: reuseAfterBrokenDoc?.reuseReason,
    })
    expect(thirdResult.ok).toBe(false)
    expect(thirdResult.evidence[1]?.checks[0]?.passed).toBe(false)
    expect(executeCommand).toHaveBeenCalledTimes(1)
  })

  it("fails closed when any non-doc, untracked code, deleted, symlink, executable, or contract change occurs", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/qa-report.md": "Initial QA report: PASS\n",
      "docs/old.md": "Old doc\n",
    })
    const { mission } = fixture()
    mission.workspace.path = root
    const initialContract = makeContract("PASS")
    mission.verificationContract = initialContract
    mission.verificationContractSha256 = goalVerificationContractDigest(initialContract)
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok 1\n", stderr: "" }))
    const firstResult = await executeGoalVerification(initialContract, root, { successCriteria, executeCommand })
    const initialManifest = await workspaceFileManifest(root)
    mission.goalVerification = firstResult
    mission.verification = { ok: true, fingerprint: initialManifest.fingerprint }
    mission.verificationBaseline = buildVerificationBaseline(firstResult, initialManifest.fingerprint)
    await saveVerificationBaselineManifest(root, initialManifest)
    const parsedContract = validateGoalVerificationContract(initialContract, successCriteria)

    // 1. Untracked non-doc file forces rerun
    await writeFile(join(root, "extra.ts"), "export const x = 1\n", "utf8")
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
    await rm(join(root, "extra.ts"))

    // 2. Modified code file forces rerun
    await writeFile(join(root, "src/app.mjs"), "export const ok = false\n", "utf8")
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
    await writeFile(join(root, "src/app.mjs"), "export const ok = true\n", "utf8")

    // 3. Symlink under docs/ forces rerun
    await symlink("qa-report.md", join(root, "docs/link.md"))
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
    await rm(join(root, "docs/link.md"))

    // 4. Executable bit on a markdown file forces rerun
    await writeFile(join(root, "docs/qa-report.md"), "Updated PASS\n", "utf8")
    await chmod(join(root, "docs/qa-report.md"), 0o755)
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
    await chmod(join(root, "docs/qa-report.md"), 0o644)

    // 5. Contract SHA change forces rerun
    const changedContract = validateGoalVerificationContract(makeContract("OTHER"), successCriteria)
    expect(await docOnlyRepairReuse(mission, changedContract)).toBeUndefined()

    // 6. Deleted non-doc file forces rerun
    await rm(join(root, "src/app.mjs"))
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
    await writeFile(join(root, "src/app.mjs"), "export const ok = true\n", "utf8")

    // 7. Missing baseline manifest on disk forces rerun
    await rm(join(root, ".agent-valley/verification-baselines", `${initialManifest.fingerprint}.json`))
    expect(await docOnlyRepairReuse(mission, parsedContract)).toBeUndefined()
  })
})

describe("Part B: operator integration check AV_INTEGRATION_EVIDENCE_FILE handoff", () => {
  const successCriteria = ["Tests pass", "Report exists"]
  const contract = {
    version: 1 as const,
    criteria: [
      {
        criterion: "Tests pass",
        checks: [
          {
            kind: "command" as const,
            program: "node" as const,
            args: ["--test", "tests/app.test.mjs"],
            timeoutMs: 120_000,
          },
        ],
      },
      {
        criterion: "Report exists",
        checks: [{ kind: "file" as const, path: "docs/report.md", minBytes: 4 }],
      },
    ],
  }

  it("populates mission.integrationEvidence from valid AV_INTEGRATION_EVIDENCE_FILE and skips redundant command in verifyMission", async () => {
    const root = await gitRepo({
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/report.md": "Report body\n",
    })
    const { mission } = fixture()
    mission.workspace.path = root
    mission.goalBrief = { interpretation: "goal", assumptions: [], ...mission.goalBrief, successCriteria }
    mission.verificationContract = contract
    mission.verificationContractSha256 = goalVerificationContractDigest(contract)

    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const active = store.processGuard(mission.id)

    const outputSha = "a".repeat(64)
    const command = `node -e '
      const fs = require("node:fs");
      const file = process.env.${INTEGRATION_EVIDENCE_FILE_ENV};
      if (!file) process.exit(2);
      fs.writeFileSync(file, JSON.stringify({
        version: 1,
        checks: [{
          program: "node",
          args: ["--test", "tests/app.test.mjs"],
          cwd: process.cwd(),
          passed: true,
          exitCode: 0,
          outputSha256: "${outputSha}"
        }]
      }));
    '`

    const result = await runIntegrationCheck(mission, active, undefined, {
      AV_INTEGRATION_CHECK_COMMAND: command,
    })
    expect(result?.ok).toBe(true)
    expect(mission.integrationEvidence).toBeDefined()
    expect(mission.integrationEvidence?.checks).toHaveLength(1)
    expect(mission.integrationEvidence?.checks[0]?.outputSha256).toBe(outputSha)

    // integrationEvidenceFor returns the evidence while workspace is identical
    const reuse = await integrationEvidenceFor(mission)
    expect(reuse).toHaveLength(1)

    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "should not run", stderr: "" }))
    const verified = await executeGoalVerification(contract, root, {
      successCriteria,
      executeCommand,
      reuse,
    })
    expect(verified.ok).toBe(true)
    expect(executeCommand).not.toHaveBeenCalled()
    expect(verified.evidence[1]?.checks[0]?.passed).toBe(true)
  })

  it("rejects AV_INTEGRATION_EVIDENCE_FILE when operator command fails or mutates the workspace", async () => {
    const root = await gitRepo({
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/report.md": "Report body\n",
    })
    const { mission } = fixture()
    mission.workspace.path = root
    mission.goalBrief = { interpretation: "goal", assumptions: [], ...mission.goalBrief, successCriteria }
    mission.verificationContract = contract
    mission.verificationContractSha256 = goalVerificationContractDigest(contract)

    const store = new MissionStore(join(root, ".agent-valley", "missions"))
    const active = store.processGuard(mission.id)
    const outputSha = "b".repeat(64)

    // 1. Failing operator command (exit 1) -> evidence ignored
    const failingCommand = `node -e '
      const fs = require("node:fs");
      fs.writeFileSync(process.env.${INTEGRATION_EVIDENCE_FILE_ENV}, JSON.stringify({
        version: 1,
        checks: [{ program: "node", args: ["--test", "tests/app.test.mjs"], cwd: process.cwd(), passed: true, exitCode: 0, outputSha256: "${outputSha}" }]
      }));
      process.exit(1);
    '`
    const failResult = await runIntegrationCheck(mission, active, undefined, {
      AV_INTEGRATION_CHECK_COMMAND: failingCommand,
    })
    expect(failResult?.ok).toBe(false)
    expect(mission.integrationEvidence).toBeUndefined()

    // 2. Operator command mutates a tracked file -> before !== after -> evidence rejected
    const mutatingCommand = `node -e '
      const fs = require("node:fs");
      fs.writeFileSync("docs/report.md", "Mutated during check\\n");
      fs.writeFileSync(process.env.${INTEGRATION_EVIDENCE_FILE_ENV}, JSON.stringify({
        version: 1,
        checks: [{ program: "node", args: ["--test", "tests/app.test.mjs"], cwd: process.cwd(), passed: true, exitCode: 0, outputSha256: "${outputSha}" }]
      }));
    '`
    const mutResult = await runIntegrationCheck(mission, active, undefined, {
      AV_INTEGRATION_CHECK_COMMAND: mutatingCommand,
    })
    expect(mutResult?.ok).toBe(true)
    expect(mission.integrationEvidence).toBeUndefined()
  })

  it("rejects malformed, non-zero, extra-field, or cwd-mismatched evidence files fail-closed", async () => {
    const root = await gitRepo({
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/report.md": "Report body\n",
    })
    const otherDir = await mkdtemp(join(tmpdir(), "av-other-cwd-"))
    roots.push(otherDir)
    const evidenceFile = join(root, ".agent-valley", "test-evidence.json")
    await mkdir(join(root, ".agent-valley"), { recursive: true })
    const fp = (await workspaceFileManifest(root)).fingerprint

    const cases = [
      "{not json",
      JSON.stringify({ version: 2, checks: [] }),
      JSON.stringify({
        version: 1,
        checks: [
          {
            program: "node",
            args: ["--test", "tests/app.test.mjs"],
            cwd: root,
            passed: false,
            exitCode: 0,
            outputSha256: "c".repeat(64),
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        checks: [
          {
            program: "node",
            args: ["--test", "tests/app.test.mjs"],
            cwd: root,
            passed: true,
            exitCode: 1,
            outputSha256: "c".repeat(64),
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        checks: [
          {
            program: "node",
            args: ["--test", "tests/app.test.mjs"],
            cwd: otherDir,
            passed: true,
            exitCode: 0,
            outputSha256: "c".repeat(64),
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        checks: [
          {
            program: "node",
            args: ["--test", "tests/app.test.mjs"],
            cwd: root,
            passed: true,
            exitCode: 0,
            outputSha256: "short",
          },
        ],
      }),
      JSON.stringify({
        version: 1,
        checks: [
          {
            program: "node",
            args: ["--test", "tests/app.test.mjs"],
            cwd: root,
            passed: true,
            exitCode: 0,
            outputSha256: "c".repeat(64),
            extraField: true,
          },
        ],
      }),
    ]

    for (const payload of cases) {
      await writeFile(evidenceFile, payload, "utf8")
      const parsed = await readOperatorIntegrationEvidence(evidenceFile, contract, successCriteria, root, fp, fp)
      expect(parsed).toBeUndefined()
    }
  })
})
