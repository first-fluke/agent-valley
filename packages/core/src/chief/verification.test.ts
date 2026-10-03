import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  executeGoalVerification,
  goalVerificationContractDigest,
  goalVerificationContractSchema,
  safeVerificationCommand,
  safeVerificationPath,
  validateGoalVerificationContract,
  validateGoalVerificationResult,
} from "./verification"
import { executeVerificationCommand } from "./verification-command"
import {
  jsonPointerValue,
  MAX_VERIFICATION_FILE_BYTES,
  readVerificationFile,
  verificationRoot,
} from "./verification-files"

const roots: string[] = []
function first<T>(items: T[]): T {
  const value = items[0]
  if (value === undefined) throw new Error("Expected fixture item")
  return value
}
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-verification-"))
  roots.push(root)
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const fileContract = (path = "result.txt") => ({
  version: 1,
  criteria: [
    {
      criterion: "The deliverable contains the required result",
      checks: [{ kind: "file", path, contains: ["actual result"] }],
    },
  ],
})
const successCriteria = ["The deliverable contains the required result"]

describe("Chief Director executable verification contracts", () => {
  it("requires exact, unique coverage and rejects claim-only or unknown checks", () => {
    expect(validateGoalVerificationContract(fileContract(), successCriteria).criteria).toHaveLength(1)
    expect(() => validateGoalVerificationContract(fileContract(), ["A different target"])).toThrow("every original")
    expect(() => validateGoalVerificationContract(fileContract(), [...successCriteria, ...successCriteria])).toThrow()
    expect(() => validateGoalVerificationContract(fileContract(), [])).toThrow()
    expect(() => goalVerificationContractSchema.parse({ version: 1, criteria: [] })).toThrow()
    expect(() =>
      goalVerificationContractSchema.parse({
        version: 1,
        criteria: [...fileContract().criteria, ...fileContract().criteria],
      }),
    ).toThrow()
    expect(() =>
      goalVerificationContractSchema.parse({
        version: 1,
        criteria: [{ criterion: "Done", checks: [{ kind: "claim", evidence: "Actor says done" }] }],
      }),
    ).toThrow()
    expect(() => goalVerificationContractSchema.parse({ ...fileContract(), ignored: "unsafe field" })).toThrow()
  })

  it.each([
    "../outside",
    "/outside",
    "a/../outside",
    "a//file",
    "./file",
    "C:/outside",
    "a\\file",
    ".git/config",
    ".agent-valley/report.md",
    ".agents/results/claim.md",
  ])("rejects escaped or runtime-generated evidence path %s", (path) => {
    expect(safeVerificationPath(path)).toBe(false)
    expect(() => goalVerificationContractSchema.parse(fileContract(path))).toThrow()
  })

  it.each([
    ["sh", ["-c", "echo success"]],
    ["node", ["-e", "process.exit(0)"]],
    ["node", ["--test"]],
    ["node", ["--test", "--import=malicious.test.js"]],
    ["node", ["--test", "../outside.test.js"]],
    ["bun", ["run", "test"]],
    ["bun", ["test", "*.test.ts"]],
    ["npm", ["install"]],
    ["git", ["push"]],
    ["git", ["diff", "--check", "--ext-diff"]],
    ["git", ["status", "--porcelain", "--ignored", "--"]],
  ])("rejects automatic command %s %j", (program, args) => {
    expect(safeVerificationCommand(program as string, args as string[])).toBe(false)
  })

  it.each([
    ["git", ["diff", "--check"]],
    ["git", ["diff", "--check", "a".repeat(40), "--", "src/main.ts"]],
    ["git", ["diff", "--check", "--cached"]],
    ["git", ["status", "--porcelain=v1", "--untracked-files=all"]],
    ["git", ["rev-parse", "--verify", "HEAD"]],
    ["git", ["ls-files", "--error-unmatch", "--", "src/main.ts"]],
    ["node", ["--test", "tests/login.test.mjs"]],
    ["node", ["node_modules/vitest/vitest.mjs", "run", "src/login.test.ts"]],
    ["bun", ["test", "src/login.test.ts", "tests/checkout.spec.tsx"]],
  ])("allows explicit command %s %j", (program, args) => {
    expect(safeVerificationCommand(program as string, args as string[])).toBe(true)
  })

  it("uses actual bytes, literal content and immutable SHA bindings", async () => {
    const root = await directory()
    const bytes = Buffer.from("An actual result")
    await writeFile(join(root, "result.txt"), bytes)
    const contract = validateGoalVerificationContract(fileContract(), successCriteria)
    const result = await executeGoalVerification(contract, root, { successCriteria })
    expect(result.ok).toBe(true)
    expect(result.evidence[0]?.checks[0]?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(result.contractSha256).toBe(goalVerificationContractDigest(contract))
    await writeFile(join(root, "result.txt"), "Actor claims success without the required output")
    expect((await executeGoalVerification(contract, root, { successCriteria })).ok).toBe(false)
    await expect(
      executeGoalVerification(contract, root, { successCriteria, expectedContractSha256: "0".repeat(64) }),
    ).rejects.toThrow("contract changed")
    const altered = structuredClone(result)
    first(altered.evidence).checks = []
    expect(() => validateGoalVerificationResult(altered, contract)).toThrow()
    const falseVerdict = structuredClone(result)
    falseVerdict.ok = false
    expect(() => validateGoalVerificationResult(falseVerdict, contract)).toThrow("completion must match")
    const swapped = structuredClone(result)
    first(first(swapped.evidence).checks).checkSha256 = "0".repeat(64)
    expect(() => validateGoalVerificationResult(swapped, contract)).toThrow("bound file")
  })

  it("checks expected hashes and minimum bytes independently of prose", async () => {
    const root = await directory()
    await writeFile(join(root, "result.txt"), "actual result")
    const input = {
      version: 1,
      criteria: [
        {
          criterion: successCriteria[0],
          checks: [{ kind: "file", path: "result.txt", minBytes: 100, sha256: "0".repeat(64) }],
        },
      ],
    }
    expect((await executeGoalVerification(input, root, { successCriteria })).ok).toBe(false)
    await writeFile(join(root, "result.txt"), "")
    expect((await executeGoalVerification(fileContract(), root, { successCriteria })).ok).toBe(false)
  })

  it("observes JSON scalars by escaped pointer and never inherited properties", async () => {
    const root = await directory()
    await writeFile(join(root, "data.json"), JSON.stringify({ "a/b": { "~key": 26 }, enabled: false }))
    const contract = {
      version: 1,
      criteria: [
        { criterion: "Node is 26", checks: [{ kind: "json", path: "data.json", pointer: "/a~1b/~0key", equals: 26 }] },
      ],
    }
    expect((await executeGoalVerification(contract, root, { successCriteria: ["Node is 26"] })).ok).toBe(true)
    expect(jsonPointerValue({}, "/toString")).toBeUndefined()
    expect(jsonPointerValue(["first"], "/0")).toBe("first")
    expect(jsonPointerValue(null, "/x")).toBeUndefined()
    expect(() =>
      goalVerificationContractSchema.parse({
        version: 1,
        criteria: [
          { criterion: "bad", checks: [{ kind: "json", path: "data.json", pointer: "/bad~2pointer", equals: 1 }] },
        ],
      }),
    ).toThrow()
    await writeFile(join(root, "data.json"), "invalid JSON")
    const invalid = await executeGoalVerification(contract, root, { successCriteria: ["Node is 26"] })
    expect(invalid.ok).toBe(false)
    expect(invalid.evidence[0]?.checks[0]?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(invalid.output).toContain("not valid UTF-8 JSON")
  })

  it("fails closed for missing files, symbolic links, directories and byte limits", async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(outside, "result.txt"), "actual result")
    await symlink(join(outside, "result.txt"), join(root, "file-link.txt"))
    await symlink(outside, join(root, "dir-link"))
    await mkdir(join(root, "directory"))
    for (const name of ["missing.txt", "file-link.txt", "dir-link/result.txt", "directory"]) {
      const result = await executeGoalVerification(fileContract(name), root, { successCriteria })
      expect(result.ok).toBe(false)
      expect(result.evidence[0]?.checks[0]?.sha256).toBeUndefined()
    }
    await writeFile(join(root, "large.txt"), Buffer.alloc(MAX_VERIFICATION_FILE_BYTES + 1))
    const result = await executeGoalVerification(fileContract("large.txt"), root, { successCriteria })
    expect(result.output).toContain("evidence budget")
    await writeFile(join(root, "small.txt"), "actual result")
    await expect(readVerificationFile(await verificationRoot(root), "small.txt", { remaining: 1 })).rejects.toThrow(
      "budget",
    )
    await expect(verificationRoot(join(root, "dir-link"))).rejects.toThrow("real directory")
  })

  it("checks actual exit/output and binds existing test inputs before invoking the executor", async () => {
    const root = await directory()
    await writeFile(join(root, "login.test.js"), "test fixture")
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "2 tests passed", stderr: "" }))
    const onSpawned = vi.fn()
    const input = {
      version: 1,
      criteria: [
        {
          criterion: "Login works",
          checks: [
            { kind: "command", program: "node", args: ["--test", "login.test.js"], stdoutIncludes: ["tests passed"] },
          ],
        },
      ],
    }
    const options = { successCriteria: ["Login works"], executeCommand, timeoutMs: 1_000, onSpawned }
    const result = await executeGoalVerification(input, root, options)
    expect(result.ok).toBe(true)
    expect(result.evidence[0]?.checks[0]?.inputs).toHaveLength(1)
    expect(result.evidence[0]?.checks[0]?.outputSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(executeCommand).toHaveBeenCalledWith(
      "node",
      ["--test", "login.test.js"],
      expect.objectContaining({ timeoutMs: 1_000, onSpawned }),
    )
    executeCommand.mockResolvedValueOnce({ exitCode: 1, stdout: "2 tests passed", stderr: "failed" })
    expect((await executeGoalVerification(input, root, options)).ok).toBe(false)
    executeCommand.mockResolvedValueOnce({ exitCode: 0, stdout: "no matching assertion", stderr: "" })
    expect((await executeGoalVerification(input, root, options)).ok).toBe(false)
    await rm(join(root, "login.test.js"))
    executeCommand.mockClear()
    expect((await executeGoalVerification(input, root, options)).ok).toBe(false)
    expect(executeCommand).not.toHaveBeenCalled()
  })

  it("detects changing tests and launcher paths escaping the worktree", async () => {
    const root = await directory()
    const outside = await directory()
    await writeFile(join(root, "login.test.js"), "original")
    const input = {
      version: 1,
      criteria: [
        { criterion: "Login works", checks: [{ kind: "command", program: "node", args: ["--test", "login.test.js"] }] },
      ],
    }
    const result = await executeGoalVerification(input, root, {
      successCriteria: ["Login works"],
      executeCommand: async () => {
        await writeFile(join(root, "login.test.js"), "changed")
        return { exitCode: 0, stdout: "passed", stderr: "" }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.output).toContain("inputs changed")
    await mkdir(join(root, "node_modules"))
    await mkdir(join(outside, "vitest"))
    await writeFile(join(outside, "vitest/vitest.mjs"), "export {}")
    await symlink(join(outside, "vitest"), join(root, "node_modules/vitest"))
    first(first(input.criteria).checks).args = ["node_modules/vitest/vitest.mjs", "run", "login.test.js"]
    expect(
      (await executeGoalVerification(input, root, { successCriteria: ["Login works"], executeCommand: vi.fn() }))
        .output,
    ).toContain("launcher escapes")
  })

  it("accepts a package-manager Vitest link contained in node_modules and hashes its launcher", async () => {
    const root = await directory()
    await mkdir(join(root, "node_modules/.cache/vitest"), { recursive: true })
    await writeFile(join(root, "node_modules/.cache/vitest/vitest.mjs"), "export {}")
    await symlink(".cache/vitest", join(root, "node_modules/vitest"))
    await writeFile(join(root, "proof.test.ts"), "test fixture")
    const result = await executeGoalVerification(
      {
        version: 1,
        criteria: [
          {
            criterion: "Test passes",
            checks: [
              { kind: "command", program: "node", args: ["node_modules/vitest/vitest.mjs", "run", "proof.test.ts"] },
            ],
          },
        ],
      },
      root,
      { successCriteria: ["Test passes"], executeCommand: async () => ({ exitCode: 0, stdout: "passed", stderr: "" }) },
    )
    expect(result.ok).toBe(true)
    expect(result.evidence[0]?.checks[0]?.inputs?.map((input) => input.path)).toEqual([
      "node_modules/.cache/vitest/vitest.mjs",
      "proof.test.ts",
    ])
  })

  it("rejects malformed and oversized injected process output instead of fabricating a passing check", async () => {
    const root = await directory()
    const input = {
      version: 1,
      criteria: [
        { criterion: "Git is clean", checks: [{ kind: "command", program: "git", args: ["diff", "--check"] }] },
      ],
    }
    for (const output of [
      { exitCode: Number.NaN, stdout: "", stderr: "" },
      { exitCode: 0, stdout: "x".repeat(1_048_577), stderr: "" },
    ]) {
      const result = await executeGoalVerification(input, root, {
        successCriteria: ["Git is clean"],
        executeCommand: async () => output,
      })
      expect(result.ok).toBe(false)
      expect(result.output).toContain("malformed or oversized")
    }
    await expect(
      executeGoalVerification(input, root, { successCriteria: ["Git is clean"], timeoutMs: -1 }),
    ).rejects.toThrow("positive bounded")
  })

  it("terminates a child when process registration fails", async () => {
    const root = await directory()
    await writeFile(join(root, "waiting.test.mjs"), "setInterval(()=>{},1000)")
    await expect(
      executeVerificationCommand("node", ["--test", "waiting.test.mjs"], {
        cwd: root,
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
        onSpawned: () => {
          throw new Error("Cannot record process")
        },
      }),
    ).rejects.toThrow("Cannot record process")
  })

  it.skipIf(process.platform === "win32")(
    "joins leaked same-group children before another command can replace their marker",
    async () => {
      const root = await directory()
      await writeFile(
        join(root, "leaky.test.mjs"),
        'import {spawn} from "node:child_process"; const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"}); child.unref();',
      )
      let pid: number | undefined
      await expect(
        executeVerificationCommand("node", ["--test", "leaky.test.mjs"], {
          cwd: root,
          timeoutMs: 5_000,
          maxOutputBytes: 4_096,
          onSpawned: (value) => {
            pid = value
          },
        }),
      ).rejects.toThrow("child processes running")
      if (!pid) throw new Error("Expected verification PID")
      const completedPid = pid
      expect(() => process.kill(-completedPid, 0)).toThrow()
    },
  )

  it("runs a real fixed-argv Node test and registers its child process", async () => {
    const root = await directory()
    await writeFile(
      join(root, "proof.test.mjs"),
      'import {test} from "node:test"; import assert from "node:assert/strict"; test("result",()=>assert.equal(2+2,4));',
    )
    const onSpawned = vi.fn()
    const result = await executeGoalVerification(
      {
        version: 1,
        criteria: [
          {
            criterion: "Calculation passes",
            checks: [{ kind: "command", program: "node", args: ["--test", "proof.test.mjs"] }],
          },
        ],
      },
      root,
      { successCriteria: ["Calculation passes"], onSpawned },
    )
    expect(result.ok).toBe(true)
    expect(onSpawned).toHaveBeenCalledWith(expect.any(Number), process.platform !== "win32")
  })

  it("terminates timed-out or noisy commands, rejects unsafe argv, and honors interruption", async () => {
    const root = await directory()
    await writeFile(join(root, "waiting.test.mjs"), "setInterval(()=>{},1000)")
    const options = { cwd: root, timeoutMs: 100, maxOutputBytes: 128 }
    await expect(executeVerificationCommand("node", ["--test", "waiting.test.mjs"], options)).rejects.toThrow(
      "timed out",
    )
    await writeFile(join(root, "noisy.test.mjs"), 'console.log("x".repeat(4096))')
    await expect(
      executeVerificationCommand("node", ["--test", "noisy.test.mjs"], { ...options, timeoutMs: 1_000 }),
    ).rejects.toThrow("output exceeds")
    await expect(executeVerificationCommand("sh", ["-c", "echo x"], options)).rejects.toThrow("Unsupported")
    const signal = AbortSignal.abort()
    await expect(executeVerificationCommand("git", ["diff", "--check"], { ...options, signal })).rejects.toThrow(
      "interrupted",
    )
    await expect(executeGoalVerification(fileContract(), root, { successCriteria, signal })).rejects.toThrow(
      "interrupted",
    )
    const controller = new AbortController()
    const pending = executeVerificationCommand("node", ["--test", "waiting.test.mjs"], {
      ...options,
      timeoutMs: 5_000,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toThrow("interrupted")
  })
})
