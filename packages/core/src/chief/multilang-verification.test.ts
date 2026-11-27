import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { clearedGitEnvironment } from "../util/git-environment"
import { runCommand } from "../workspace/worktree-lifecycle"
import { workspaceFileManifest } from "./fingerprint"
import { fixture } from "./goal-supervision.fixture"
import { planPrompt } from "./prompts"
import { operatorCommandEvidenceSchema } from "./runtime-integration-check"
import {
  executeGoalVerification,
  goalVerificationContractSchema,
  safeVerificationCommand,
  VERIFICATION_COMMAND_PROGRAMS,
  validateGoalVerificationContract,
  verificationCommandTestPaths,
} from "./verification"
import { verificationCommandInputs } from "./verification-command"
import { verificationBudget, verificationRoot } from "./verification-files"
import { buildVerificationBaseline, docOnlyRepairReuse, saveVerificationBaselineManifest } from "./verification-reuse"

const dirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir("av-multilang-verify-")
  const git = async (...args: string[]) => {
    const res = await runCommand("git", args, { cwd: root, env: clearedGitEnvironment })
    if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`)
  }
  await git("init", "-q")
  await git("config", "user.email", "test@example.com")
  await git("config", "user.name", "Test")
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, ".."), { recursive: true })
    await writeFile(full, content, "utf8")
  }
  await git("add", "-A")
  await git("commit", "-q", "-m", "init")
  return root
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("Multi-language verification command contracts", () => {
  it("exports shared VERIFICATION_COMMAND_PROGRAMS across contract and operator evidence schemas", () => {
    expect(VERIFICATION_COMMAND_PROGRAMS).toEqual(["git", "node", "bun", "cargo", "go", "pytest", "swift", "dart"])
    for (const [program, args] of [
      ["go", ["test", "./..."]],
      ["pytest", ["-q", "tests/test_app.py"]],
      ["swift", ["test"]],
      ["dart", ["analyze"]],
    ] as const) {
      expect(
        operatorCommandEvidenceSchema.safeParse({
          program,
          args: [...args],
          cwd: "/workspace",
          passed: true,
          exitCode: 0,
          outputSha256: "a".repeat(64),
        }).success,
      ).toBe(true)
    }
  })

  it.each([
    ["go", ["test", "./..."], ["go.mod"]],
    ["go", ["test", "-count=1", "./..."], ["go.mod"]],
    ["go", ["vet", "./..."], ["go.mod"]],
    ["pytest", ["tests/test_app.py"], ["tests/test_app.py"]],
    ["pytest", ["-q", "./tests/test_app.py", "pkg/auth_test.py"], ["tests/test_app.py", "pkg/auth_test.py"]],
    ["swift", ["test"], ["Package.swift"]],
    ["dart", ["analyze"], ["pubspec.yaml"]],
    ["dart", ["test"], ["pubspec.yaml"]],
    [
      "dart",
      ["test", "./test/widget_test.dart", "test/api_test.dart"],
      ["test/widget_test.dart", "test/api_test.dart"],
    ],
  ] as const)("allows safe %s command %j and extracts test paths %j", (program, args, expectedPaths) => {
    expect(safeVerificationCommand(program, [...args])).toBe(true)
    expect(verificationCommandTestPaths(program, [...args])).toEqual([...expectedPaths])
    const parsed = goalVerificationContractSchema.safeParse({
      version: 1,
      criteria: [{ criterion: "passes", checks: [{ kind: "command", program, args: [...args] }] }],
    })
    expect(parsed.success).toBe(true)
  })

  it.each([
    ["go", ["run", "main.go"]],
    ["go", ["install", "./..."]],
    ["go", ["test", "-exec", "sh", "./..."]],
    ["go", ["test", "./cmd/..."]],
    ["go", ["vet", "-vettool=evil", "./..."]],
    ["pytest", []],
    ["pytest", ["-q"]],
    ["pytest", ["-k", "test_foo", "tests/test_app.py"]],
    ["pytest", ["-c", "pyproject.toml", "tests/test_app.py"]],
    ["pytest", ["--override-ini=foo=bar", "tests/test_app.py"]],
    ["pytest", ["tests/test_*.py"]],
    ["pytest", ["tests"]],
    ["pytest", ["tests/helper.py"]],
    ["pytest", [".venv/lib/test_app.py"]],
    ["pytest", ["node_modules/pkg/test_app.py"]],
    ["pytest", ["../outside/test_app.py"]],
    ["swift", ["build"]],
    ["swift", ["test", "--filter", "Foo"]],
    ["dart", ["run", "tool.dart"]],
    ["dart", ["analyze", "--fatal-infos"]],
    ["dart", ["test", "--reporter=expanded"]],
    ["dart", ["test", "test/*_test.dart"]],
    ["dart", ["test", "lib/app.dart"]],
    ["dart", ["test", ".dart_tool/foo_test.dart"]],
  ] as const)("rejects unsafe %s command %j", (program, args) => {
    expect(safeVerificationCommand(program, [...args])).toBe(false)
    if (args.length > 0) {
      const parsed = goalVerificationContractSchema.safeParse({
        version: 1,
        criteria: [{ criterion: "passes", checks: [{ kind: "command", program, args: [...args] }] }],
      })
      expect(parsed.success).toBe(false)
    }
  })

  it("documents Go, Python, Swift, and Dart checks in planPrompt", () => {
    const { mission } = fixture()
    mission.verificationMode = "chief"
    const prompt = planPrompt(mission)
    expect(prompt).toContain('"program":"go"')
    expect(prompt).toContain('"program":"pytest"')
    expect(prompt).toContain('"program":"swift"')
    expect(prompt).toContain('"program":"dart"')
  })
})

describe("Multi-language workspace verification input binding", () => {
  it("binds Go manifests and sources, excludes vendor/, rejects symlinks and missing go.mod", async () => {
    const dir = await makeTempDir("av-go-inputs-")
    await writeFile(join(dir, "go.mod"), "module example.com/app\n")
    await writeFile(join(dir, "go.sum"), "")
    await writeFile(join(dir, "go.work"), "go 1.23\n")
    await mkdir(join(dir, "pkg"), { recursive: true })
    await writeFile(join(dir, "pkg/app.go"), "package pkg\n")
    await mkdir(join(dir, "vendor/dep"), { recursive: true })
    await writeFile(join(dir, "vendor/dep/dep.go"), "package dep\n")

    const root = await verificationRoot(dir)
    const inputs = await verificationCommandInputs(root, "go", ["test", "./..."], verificationBudget())
    expect(inputs.map((entry) => entry.path)).toEqual(["go.mod", "go.sum", "go.work", "pkg/app.go"])

    // Symlinked .go file is rejected
    await symlink(join(dir, "pkg/app.go"), join(dir, "pkg/link.go"))
    await expect(verificationCommandInputs(root, "go", ["test", "./..."], verificationBudget())).rejects.toThrow(
      /symlinked workspace inputs/,
    )

    // Missing root go.mod is rejected
    const noManifest = await makeTempDir("av-go-missing-")
    await writeFile(join(noManifest, "main.go"), "package main\n")
    await expect(
      verificationCommandInputs(await verificationRoot(noManifest), "go", ["vet", "./..."], verificationBudget()),
    ).rejects.toThrow(/requires go\.mod/)
  })

  it("binds Swift manifests and sources, excludes .build/, and requires Package.swift", async () => {
    const dir = await makeTempDir("av-swift-inputs-")
    await writeFile(join(dir, "Package.swift"), "// swift-tools-version: 5.9\n")
    await writeFile(join(dir, "Package.resolved"), "{}\n")
    await mkdir(join(dir, "Sources/App"), { recursive: true })
    await writeFile(join(dir, "Sources/App/Main.swift"), "let x = 1\n")
    await mkdir(join(dir, ".build/debug"), { recursive: true })
    await writeFile(join(dir, ".build/debug/gen.swift"), "// generated\n")

    const root = await verificationRoot(dir)
    const inputs = await verificationCommandInputs(root, "swift", ["test"], verificationBudget())
    expect(inputs.map((entry) => entry.path)).toEqual(["Package.resolved", "Package.swift", "Sources/App/Main.swift"])

    const noManifest = await makeTempDir("av-swift-missing-")
    await expect(
      verificationCommandInputs(await verificationRoot(noManifest), "swift", ["test"], verificationBudget()),
    ).rejects.toThrow(/requires Package\.swift/)
  })

  it("binds Dart workspace inputs for bare analyze/test and explicit paths for dart test <files> / pytest", async () => {
    const dir = await makeTempDir("av-dart-inputs-")
    await writeFile(join(dir, "pubspec.yaml"), "name: app\n")
    await writeFile(join(dir, "pubspec.lock"), "# lock\n")
    await writeFile(join(dir, "analysis_options.yaml"), "linter:\n")
    await mkdir(join(dir, "lib"), { recursive: true })
    await writeFile(join(dir, "lib/app.dart"), "int add(int a, int b) => a + b;\n")
    await mkdir(join(dir, "test"), { recursive: true })
    await writeFile(join(dir, "test/app_test.dart"), "void main() {}\n")
    await mkdir(join(dir, ".dart_tool"), { recursive: true })
    await writeFile(join(dir, ".dart_tool/generated.dart"), "// ignored\n")
    await mkdir(join(dir, "tests"), { recursive: true })
    await writeFile(join(dir, "tests/test_app.py"), "def test_ok():\n    assert True\n")

    const root = await verificationRoot(dir)
    const bareInputs = await verificationCommandInputs(root, "dart", ["analyze"], verificationBudget())
    expect(bareInputs.map((entry) => entry.path)).toEqual([
      "analysis_options.yaml",
      "lib/app.dart",
      "pubspec.lock",
      "pubspec.yaml",
      "test/app_test.dart",
    ])

    const explicitDart = await verificationCommandInputs(
      root,
      "dart",
      ["test", "test/app_test.dart"],
      verificationBudget(),
    )
    expect(explicitDart.map((entry) => entry.path)).toEqual(["test/app_test.dart"])

    const explicitPytest = await verificationCommandInputs(
      root,
      "pytest",
      ["-q", "./tests/test_app.py"],
      verificationBudget(),
    )
    expect(explicitPytest.map((entry) => entry.path)).toEqual(["tests/test_app.py"])

    const noManifest = await makeTempDir("av-dart-missing-")
    await expect(
      verificationCommandInputs(await verificationRoot(noManifest), "dart", ["test"], verificationBudget()),
    ).rejects.toThrow(/requires pubspec\.yaml/)
  })

  it("reuses passing go, pytest, swift, and dart command evidence across doc-only repairs", async () => {
    const root = await gitRepo({
      "go.mod": "module example.com/poly\n",
      "main.go": "package main\n",
      "tests/test_app.py": "def test_ok():\n    assert True\n",
      "Package.swift": "// swift-tools-version: 5.9\n",
      "Sources/main.swift": "print(1)\n",
      "pubspec.yaml": "name: poly\n",
      "test/app_test.dart": "void main() {}\n",
      "docs/summary.md": "Initial summary\n",
    })
    const successCriteria = ["Polyglot tests pass", "Docs updated"]
    const contract = validateGoalVerificationContract(
      {
        version: 1,
        criteria: [
          {
            criterion: "Polyglot tests pass",
            checks: [
              { kind: "command", program: "go", args: ["test", "./..."] },
              { kind: "command", program: "pytest", args: ["-q", "tests/test_app.py"] },
              { kind: "command", program: "swift", args: ["test"] },
              { kind: "command", program: "dart", args: ["test", "test/app_test.dart"] },
            ],
          },
          {
            criterion: "Docs updated",
            checks: [{ kind: "file", path: "docs/summary.md", minBytes: 5 }],
          },
        ],
      },
      successCriteria,
    )

    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok\n", stderr: "" }))
    const initial = await executeGoalVerification(contract, root, { successCriteria, executeCommand })
    expect(initial.ok).toBe(true)
    expect(executeCommand).toHaveBeenCalledTimes(4)

    const initialManifest = await workspaceFileManifest(root)
    const baseline = buildVerificationBaseline(initial, initialManifest.fingerprint)
    expect(baseline?.checks).toHaveLength(4)
    await saveVerificationBaselineManifest(root, initialManifest)

    const { mission } = fixture()
    mission.workspace.path = root
    mission.verificationBaseline = baseline

    // Edit only docs/summary.md -> all 4 language commands are reusable!
    await writeFile(join(root, "docs/summary.md"), "Updated summary\n", "utf8")
    const reuse = await docOnlyRepairReuse(mission, contract)
    expect(reuse?.checks).toHaveLength(4)
    expect(reuse?.changedDocPaths).toEqual(["docs/summary.md"])
  })
})
