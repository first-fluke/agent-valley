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
  reusableEvidence,
  runIntegrationCheck,
} from "./runtime-integration-check"
import { MissionStore } from "./store"
import {
  executeGoalVerification,
  goalVerificationContractDigest,
  isPassingCommandEvidence,
  validateGoalVerificationContract,
  validateGoalVerificationResult,
} from "./verification"
import {
  buildVerificationBaseline,
  canReusePriorVerification,
  docOnlyRepairReuse,
  isContractDocEvidencePath,
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

describe("isContractDocEvidencePath", () => {
  const contractPaths = new Set([
    ".arc-verify/phase-2-vendor-catalogue/qa.md",
    ".arc-verify/summary.mdx",
    "docs/qa-report.md",
  ])

  it("allows contract-declared markdown evidence paths inside dot-directories", () => {
    expect(isContractDocEvidencePath(".arc-verify/phase-2-vendor-catalogue/qa.md", contractPaths)).toBe(true)
    expect(isContractDocEvidencePath(".arc-verify/summary.mdx", contractPaths)).toBe(true)
    expect(isContractDocEvidencePath("docs/qa-report.md", contractPaths)).toBe(true)
  })

  it("rejects paths not declared in contractFilePaths", () => {
    expect(isContractDocEvidencePath(".arc-verify/other.md", contractPaths)).toBe(false)
  })

  it("rejects non-markdown filenames even if in contractPaths", () => {
    const withScripts = new Set([".arc-verify/test.sh", ".arc-verify/data.json"])
    expect(isContractDocEvidencePath(".arc-verify/test.sh", withScripts)).toBe(false)
    expect(isContractDocEvidencePath(".arc-verify/data.json", withScripts)).toBe(false)
  })

  it.each([
    ".git/qa.md",
    ".github/qa.md",
    ".gitlab/qa.md",
    ".circleci/qa.md",
    ".claude/qa.md",
    ".codex/qa.md",
    ".cursor/qa.md",
    ".agents/qa.md",
    ".agent-valley/qa.md",
    ".vscode/qa.md",
    ".idea/qa.md",
    ".husky/qa.md",
    ".config/qa.md",
    ".cargo/qa.md",
    ".yarn/qa.md",
    ".pnpm/qa.md",
    ".npm/qa.md",
    ".bun/qa.md",
    ".venv/qa.md",
    ".tox/qa.md",
    ".env/qa.md",
    ".env.local/qa.md",
  ])("rejects sensitive dot-directory path %s even if in contractPaths", (path) => {
    const declared = new Set([path])
    expect(isContractDocEvidencePath(path, declared)).toBe(false)
  })

  it("rejects dot-filenames starting with dot", () => {
    const hidden = new Set([".arc-verify/.hidden.md"])
    expect(isContractDocEvidencePath(".arc-verify/.hidden.md", hidden)).toBe(false)
  })

  it("rejects non-doc segments", () => {
    const testSegment = new Set([".arc-verify/test/qa.md", ".arc-verify/node_modules/qa.md"])
    expect(isContractDocEvidencePath(".arc-verify/test/qa.md", testSegment)).toBe(false)
    expect(isContractDocEvidencePath(".arc-verify/node_modules/qa.md", testSegment)).toBe(false)
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

  it("builds verification baseline even when result.ok is false if all command checks pass", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      ".arc-verify/qa.md": "Draft QA report\n",
    })
    const contractWithFailingFile = {
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
          criterion: "QA report present with PASS",
          checks: [
            {
              kind: "file" as const,
              path: ".arc-verify/qa.md",
              minBytes: 4,
              contains: ["PASS_FINAL_TOKEN"],
            },
          ],
        },
      ],
    }
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }))
    const result = await executeGoalVerification(contractWithFailingFile, root, {
      successCriteria: ["Tests pass", "QA report present with PASS"],
      executeCommand,
    })
    expect(result.ok).toBe(false)
    expect(result.evidence[0]?.checks[0]?.passed).toBe(true) // command passed
    expect(result.evidence[1]?.checks[0]?.passed).toBe(false) // file check failed

    const manifest = await workspaceFileManifest(root)
    const baseline = buildVerificationBaseline(result, manifest.fingerprint)
    expect(baseline).toBeDefined()
    expect(baseline?.checks).toHaveLength(1)
    expect(baseline?.checks[0]?.passed).toBe(true)
  })

  it("reuses passing command baseline when contract-declared dot-directory markdown file changes (.arc-verify/qa.md)", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      ".arc-verify/phase-2/qa.md": "Initial draft\n",
    })
    const contract = validateGoalVerificationContract(
      {
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
            criterion: "QA report verified",
            checks: [
              {
                kind: "file" as const,
                path: ".arc-verify/phase-2/qa.md",
                minBytes: 4,
                contains: ["TRF-019"],
              },
            ],
          },
        ],
      },
      ["Tests pass", "QA report verified"],
    )

    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }))
    const initialResult = await executeGoalVerification(contract, root, {
      successCriteria: ["Tests pass", "QA report verified"],
      executeCommand,
    })
    // Initial verification failed because .arc-verify/phase-2/qa.md lacks TRF-019
    expect(initialResult.ok).toBe(false)
    expect(executeCommand).toHaveBeenCalledTimes(1)

    // Save baseline from the passing command check
    const initialManifest = await workspaceFileManifest(root)
    const baseline = buildVerificationBaseline(initialResult, initialManifest.fingerprint)
    expect(baseline).toBeDefined()
    await saveVerificationBaselineManifest(root, initialManifest)

    const { mission } = fixture()
    mission.workspace.path = root
    mission.verificationBaseline = baseline

    // Now repair task delivers the fix to .arc-verify/phase-2/qa.md
    await writeFile(join(root, ".arc-verify/phase-2/qa.md"), "Validated TRF-019 passing\n", "utf8")

    const reuse = await docOnlyRepairReuse(mission, contract)
    expect(reuse).toBeDefined()
    expect(reuse?.checks).toHaveLength(1)
    expect(reuse?.changedDocPaths).toEqual([".arc-verify/phase-2/qa.md"])

    // Second verification reuses command evidence without re-executing node test!
    const secondResult = await executeGoalVerification(contract, root, {
      successCriteria: ["Tests pass", "QA report verified"],
      executeCommand,
      reuse: reuse?.checks,
      reuseReason: reuse?.reuseReason,
    })
    expect(secondResult.ok).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(1) // Still 1! Not called again!
    expect(secondResult.evidence[1]?.checks[0]?.passed).toBe(true)
  })

  it("strictly rejects command reuse if recorded command inputs included the changed file", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      ".arc-verify/qa.md": "Initial\n",
    })
    const contract = validateGoalVerificationContract(
      {
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
            criterion: "QA report verified",
            checks: [
              {
                kind: "file" as const,
                path: ".arc-verify/qa.md",
                minBytes: 4,
              },
            ],
          },
        ],
      },
      ["Tests pass", "QA report verified"],
    )

    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }))
    const initialResult = await executeGoalVerification(contract, root, {
      successCriteria: ["Tests pass", "QA report verified"],
      executeCommand,
    })
    const initialManifest = await workspaceFileManifest(root)
    const baseline = buildVerificationBaseline(initialResult, initialManifest.fingerprint)
    if (!baseline?.checks[0]) throw new Error("Expected baseline")
    // Simulate that the command recorded .arc-verify/qa.md as an input (e.g. include_str!)
    baseline.checks[0].inputs = [{ path: ".arc-verify/qa.md", sha256: "e".repeat(64) }]
    await saveVerificationBaselineManifest(root, initialManifest)

    const { mission } = fixture()
    mission.workspace.path = root
    mission.verificationBaseline = baseline

    // Change .arc-verify/qa.md
    await writeFile(join(root, ".arc-verify/qa.md"), "Updated\n", "utf8")

    // docOnlyRepairReuse must NOT claim reuse for the command because its inputs include the changed file!
    const reuse = await docOnlyRepairReuse(mission, contract)
    expect(reuse).toBeUndefined()
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

describe("Part C: flaky-rerun passing command evidence in baseline and reuse", () => {
  const successCriteria = ["Tests pass", "QA report is present"]
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
        criterion: "QA report is present",
        checks: [{ kind: "file" as const, path: "docs/qa-report.md", minBytes: 4, contains: ["PASS"] }],
      },
    ],
  }

  function cargoFlakyRun(verdicts: Record<string, "ok" | "FAILED">) {
    const lines = Object.entries(verdicts).map(([name, verdict]) => `test ${name} ... ${verdict}`)
    const failures = Object.values(verdicts).filter((verdict) => verdict === "FAILED").length
    return {
      exitCode: 101,
      stdout: `running ${lines.length} tests\n${lines.join("\n")}\n\ntest result: FAILED. ${lines.length - failures} passed; ${failures} failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n`,
      stderr: "error: 1 target failed:\n    `-p arc-daemon --test suite`\n",
    }
  }

  it("accepts flaky-rerun passed evidence (exitCode 101 + nondeterministic) in buildVerificationBaseline, docOnlyRepairReuse, reusableEvidence, and executeGoalVerification reuse while preserving metadata", async () => {
    const root = await gitRepo({
      "src/app.mjs": "export const ok = true\n",
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/qa-report.md": "Initial QA report: PASS\n",
    })
    const { mission } = fixture()
    mission.workspace.path = root
    mission.verificationContract = contract
    mission.verificationContractSha256 = goalVerificationContractDigest(contract)

    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce(cargoFlakyRun({ flaky_a: "FAILED", flaky_b: "ok" }))
      .mockResolvedValueOnce(cargoFlakyRun({ flaky_a: "ok", flaky_b: "FAILED" }))

    const firstResult = await executeGoalVerification(contract, root, {
      successCriteria,
      executeCommand,
      commandReruns: 1,
    })
    expect(firstResult.ok).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(2)
    const firstCheck = firstResult.evidence[0]?.checks[0]
    expect(firstCheck).toMatchObject({
      kind: "command",
      passed: true,
      exitCode: 101,
      nondeterministic: ["flaky_a", "flaky_b"],
    })
    expect(firstCheck && isPassingCommandEvidence(firstCheck)).toBe(true)

    const initialManifest = await workspaceFileManifest(root)
    const baseline = buildVerificationBaseline(firstResult, initialManifest.fingerprint)
    expect(baseline).toBeDefined()
    expect(baseline?.checks).toHaveLength(1)
    expect(baseline?.checks[0]).toMatchObject({
      passed: true,
      exitCode: 101,
      nondeterministic: ["flaky_a", "flaky_b"],
    })

    // reusableEvidence also accepts flaky-rerun passing command checks
    const intEvidence = reusableEvidence(
      { ok: true, evidence: baseline?.checks ?? [] },
      initialManifest.fingerprint,
      initialManifest.fingerprint,
    )
    expect(intEvidence?.checks).toHaveLength(1)
    expect(intEvidence?.checks[0]?.nondeterministic).toEqual(["flaky_a", "flaky_b"])

    // Save baseline and perform a doc-only repair
    mission.goalVerification = firstResult
    mission.verification = { ok: true, fingerprint: initialManifest.fingerprint }
    mission.verificationBaseline = baseline
    await saveVerificationBaselineManifest(root, initialManifest)
    await writeFile(join(root, "docs/qa-report.md"), "Updated QA report: PASS\n", "utf8")

    const parsedContract = validateGoalVerificationContract(contract, successCriteria)
    const reuse = await docOnlyRepairReuse(mission, parsedContract)
    expect(reuse).toBeDefined()
    expect(reuse?.checks).toHaveLength(1)
    expect(reuse?.reuseReason).toContain("passed in the previous passing verification")
    expect(reuse?.reuseReason).toContain("only documentation files changed")

    // Re-running goal verification reuses the flaky-rerun command without executing it again
    const secondResult = await executeGoalVerification(contract, root, {
      successCriteria,
      executeCommand,
      reuse: reuse?.checks,
      reuseReason: reuse?.reuseReason,
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(secondResult.ok).toBe(true)
    expect(() => validateGoalVerificationResult(secondResult, parsedContract)).not.toThrow()
    expect(secondResult.evidence[0]?.checks[0]).toMatchObject({
      passed: true,
      exitCode: 101,
      nondeterministic: ["flaky_a", "flaky_b"],
    })
    expect(secondResult.evidence[0]?.checks[0]?.summary).toContain("NONDETERMINISTIC: flaky_a, flaky_b")
    expect(secondResult.evidence[0]?.checks[0]?.summary).toContain("only documentation files changed")
  })

  it("strictly rejects genuine failures and unproven non-zero command checks in buildVerificationBaseline and reusableEvidence", async () => {
    const root = await gitRepo({
      "tests/app.test.mjs": "import test from 'node:test'\ntest('ok', () => {})\n",
      "docs/qa-report.md": "QA report: PASS\n",
    })
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }))
    const baseResult = await executeGoalVerification(contract, root, { successCriteria, executeCommand })
    const fp = (await workspaceFileManifest(root)).fingerprint

    // 1. Genuine failure: result.ok === false, check.passed === false, exitCode: 101
    const failedResult = structuredClone(baseResult)
    failedResult.ok = false
    if (failedResult.evidence[0]?.checks[0]) {
      failedResult.evidence[0].passed = false
      failedResult.evidence[0].checks[0].passed = false
      failedResult.evidence[0].checks[0].exitCode = 101
    }
    expect(buildVerificationBaseline(failedResult, fp)).toBeUndefined()
    expect(reusableEvidence({ ok: true, evidence: failedResult.evidence[0]?.checks ?? [] }, fp, fp)).toBeUndefined()

    // 2. Genuine failure: check.passed === false even with exitCode: 0 (e.g. missing stdoutIncludes)
    const failedZero = structuredClone(baseResult)
    if (failedZero.evidence[0]?.checks[0]) {
      failedZero.evidence[0].checks[0].passed = false
      failedZero.evidence[0].checks[0].exitCode = 0
    }
    expect(buildVerificationBaseline(failedZero, fp)).toBeUndefined()

    // 3. Unproven non-zero pass: passed === true, exitCode === 101, but NO nondeterministic verdicts
    const unprovenNonZero = structuredClone(baseResult)
    if (unprovenNonZero.evidence[0]?.checks[0]) {
      unprovenNonZero.evidence[0].checks[0].passed = true
      unprovenNonZero.evidence[0].checks[0].exitCode = 101
      delete unprovenNonZero.evidence[0].checks[0].nondeterministic
    }
    expect(buildVerificationBaseline(unprovenNonZero, fp)).toBeUndefined()
    expect(reusableEvidence({ ok: true, evidence: unprovenNonZero.evidence[0]?.checks ?? [] }, fp, fp)).toBeUndefined()

    // 4. Missing outputSha256
    const missingSha = structuredClone(baseResult)
    if (missingSha.evidence[0]?.checks[0]) {
      delete missingSha.evidence[0].checks[0].outputSha256
    }
    expect(buildVerificationBaseline(missingSha, fp)).toBeUndefined()
  })

  it("canReusePriorVerification rejects completed missions, invalid history, or post-verification operator notes", () => {
    const { mission } = fixture()
    mission.plan = {
      tasks: [
        {
          id: "onboarding",
          title: "Onboarding",
          personaId: "worker",
          instructions: "Do it",
          acceptance: ["Works"],
          dependencies: [],
        },
      ],
    }
    mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "change-1",
        review: { passed: true, summary: "ok", findings: [] },
      },
    ]
    mission.initialFingerprint = "initial"
    mission.fingerprint = "change-1"
    mission.verification = { ok: true, output: "PASS", fingerprint: "change-1" }
    mission.status = "paused"
    mission.history = [
      { at: "2026-11-25T21:00:00.000Z", stage: "work", message: "done" },
      { at: "2026-11-25T22:50:09.000Z", stage: "verify", message: "Verification passed." },
      { at: "2026-11-25T22:53:13.000Z", stage: "paused", message: "ENOTFOUND" },
    ]

    expect(canReusePriorVerification(mission, "change-1")).toBe(true)

    // Fingerprint mismatch
    expect(canReusePriorVerification(mission, "change-2")).toBe(false)

    // Completed mission still re-verifies
    const completed = structuredClone(mission)
    completed.status = "completed"
    expect(canReusePriorVerification(completed, "change-1")).toBe(false)

    // Operator note BEFORE verification is allowed
    const preNote = structuredClone(mission)
    preNote.operatorNotes = [{ at: "2026-11-25T20:00:00.000Z", text: "Early note" }]
    expect(canReusePriorVerification(preNote, "change-1")).toBe(true)

    // Operator note AT or AFTER verification forces re-verify
    const postNote = structuredClone(mission)
    postNote.operatorNotes = [{ at: "2026-11-25T22:55:00.000Z", text: "Re-run verification now" }]
    expect(canReusePriorVerification(postNote, "change-1")).toBe(false)

    const sameMsNote = structuredClone(mission)
    sameMsNote.operatorNotes = [{ at: "2026-11-25T22:50:09.000Z", text: "Same-ms note" }]
    expect(canReusePriorVerification(sameMsNote, "change-1")).toBe(false)

    // Repair event after passing verify forces re-verify
    const afterRepair = structuredClone(mission)
    afterRepair.history.push({ at: "2026-11-25T22:54:00.000Z", stage: "repair", message: "Repair task" })
    expect(canReusePriorVerification(afterRepair, "change-1")).toBe(false)
  })
})
