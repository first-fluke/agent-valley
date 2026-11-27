import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { z } from "zod"

export const VERIFICATION_COMMAND_PROGRAMS = ["git", "node", "bun", "cargo", "go", "pytest", "swift", "dart"] as const

const text = z.string().trim().min(1).max(4_000)
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)

/** Paths are literal repository-relative names, never globs or shell expressions. */
export function safeVerificationPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1_024 &&
    !isAbsolute(path) &&
    !/^[a-z]:/i.test(path) &&
    !/[\\\0\r\n]/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
    !/^(?:\.git(?:\/|$)|\.agent-valley(?:\/|$)|\.agents\/(?:state|results)(?:\/|$))/.test(path)
  )
}

const path = z.string().refine(safeVerificationPath, "Use a literal relative product path inside the worktree.")
const testPath = (name: string, nodeOnly = false): boolean =>
  safeVerificationPath(name) &&
  !name.startsWith("-") &&
  !/[*?{}]/.test(name) &&
  !name.startsWith("node_modules/") &&
  (nodeOnly ? /(?:\.test|\.spec)\.(?:js|mjs|cjs)$/ : /(?:\.test|\.spec)\.(?:[cm]?[jt]sx?)$/).test(name)

const pytestTestPath = (name: string): boolean =>
  safeVerificationPath(name) &&
  !name.startsWith("-") &&
  !/[*?{}]/.test(name) &&
  !name.startsWith("node_modules/") &&
  !name.startsWith(".venv/") &&
  /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.py)$/.test(name)

const dartTestPath = (name: string): boolean =>
  safeVerificationPath(name) &&
  !name.startsWith("-") &&
  !/[*?{}]/.test(name) &&
  !name.startsWith(".dart_tool/") &&
  /(?:^|\/)[^/]+_test\.dart$/.test(name)

/** Planners often write `./tests/x.test.ts`; it names the same repository-relative file. */
const plainTestPath = (name: string): string => (name.startsWith("./") && name.length > 2 ? name.slice(2) : name)

const exactArgs = (args: string[], allowed: readonly (readonly string[])[]): boolean =>
  allowed.some((shape) => args.length === shape.length && args.every((arg, index) => arg === shape[index]))

export function verificationCommandTestPaths(program: string, args: string[]): string[] {
  if (program === "cargo") return ["Cargo.toml"]
  if (program === "go") return ["go.mod"]
  if (program === "swift") return ["Package.swift"]
  if (program === "dart") {
    if (args[0] === "analyze" && args.length === 1) return ["pubspec.yaml"]
    if (args[0] === "test") return args.length === 1 ? ["pubspec.yaml"] : args.slice(1).map(plainTestPath)
    return []
  }
  if (program === "pytest") {
    const paths = args[0] === "-q" ? args.slice(1) : args
    return paths.map(plainTestPath)
  }
  if (program === "bun" && args[0] === "test") return args.slice(1).map(plainTestPath)
  if (program === "node" && args[0] === "--test") return args.slice(1).map(plainTestPath)
  if (program === "node" && args[0] === "node_modules/vitest/vitest.mjs" && args[1] === "run")
    return args.slice(2).map(plainTestPath)
  return []
}

/** Package scripts, shells, interpreter eval flags and implicit discovery are excluded. */
export function safeVerificationCommand(program: string, args: string[]): boolean {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) return false
  if (program === "cargo")
    return exactArgs(args, [
      ["fmt", "--all", "--", "--check"],
      ["clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      ["test", "--workspace"],
      ["test", "--workspace", "--no-fail-fast"],
    ])
  if (program === "go")
    return exactArgs(args, [
      ["test", "./..."],
      ["test", "-count=1", "./..."],
      ["vet", "./..."],
    ])
  if (program === "swift") return exactArgs(args, [["test"]])
  if (program === "dart") {
    if (exactArgs(args, [["analyze"], ["test"]])) return true
    if (args[0] === "test" && args.length > 1) return args.slice(1).map(plainTestPath).every(dartTestPath)
    return false
  }
  if (program === "pytest") {
    const paths = args[0] === "-q" ? args.slice(1) : args
    return paths.length > 0 && paths.map(plainTestPath).every(pytestTestPath)
  }
  if (program === "bun" || program === "node") {
    const tests = verificationCommandTestPaths(program, args)
    return tests.length > 0 && tests.every((name) => testPath(name, program === "node" && args[0] === "--test"))
  }
  if (program !== "git") return false
  if (args.join("\0") === ["rev-parse", "--verify", "HEAD"].join("\0")) return true
  if (
    args[0] === "status" &&
    args.length >= 2 &&
    args.slice(1).every((arg) => ["--porcelain", "--porcelain=v1", "--short", "--untracked-files=all"].includes(arg))
  )
    return true
  if (args[0] === "ls-files" && args[1] === "--error-unmatch" && args[2] === "--" && args.length > 3)
    return args.slice(3).every(safeVerificationPath)
  if (args[0] !== "diff" || args[1] !== "--check") return false
  const tail = args.slice(2)
  if (tail[0] === "--cached") tail.shift()
  if (tail[0] && /^[a-f0-9]{40,64}$/.test(tail[0])) tail.shift()
  return tail.length === 0 || (tail.shift() === "--" && tail.every(safeVerificationPath))
}

export const goalVerificationCheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("file"),
    path,
    minBytes: z.number().int().min(1).max(4_194_304).default(1),
    contains: z.array(text).max(20).optional(),
    sha256: sha256.optional(),
  }),
  z.strictObject({
    kind: z.literal("json"),
    path,
    pointer: z
      .string()
      .max(1_024)
      .refine((value) => value === "" || /^(?:\/(?:[^~]|~[01])*)+$/.test(value), {
        message: "Use an RFC 6901 JSON pointer such as /engines/node.",
      }),
    equals: z.union([
      z.string().max(4_000),
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()])).max(50),
    ]),
  }),
  z
    .strictObject({
      kind: z.literal("command"),
      program: z.enum(VERIFICATION_COMMAND_PROGRAMS),
      args: z.array(z.string().min(1).max(1_024)).min(1).max(30),
      /** Planning-time estimate; the operator's per-check timeout governs when the mission runs. */
      timeoutMs: z.number().int().min(100).max(3_600_000).default(120_000),
      stdoutIncludes: z.array(text).max(20).optional(),
    })
    .superRefine((check, ctx) => {
      if (safeVerificationCommand(check.program, check.args)) return
      // Name the rejected argv: a generic rule left planners guessing which check to change.
      const rejected = `${check.program} ${check.args.join(" ")}`.slice(0, 300)
      const hint =
        check.program === "bun" || check.program === "node"
          ? " bun test and node --test take only explicit test file paths ending in .test or .spec; a bare test command, flags such as --cwd, globs and package scripts are rejected, so list each test file or record the gate in a JSON report checked by pointer."
          : check.program === "pytest"
            ? " pytest takes optional -q followed by explicit test_*.py or *_test.py file paths only; bare pytest, other flags, globs and directories are rejected."
            : ""
      ctx.addIssue({
        code: "custom",
        message: `Rejected command: ${rejected}.${hint} Use explicit node/bun/Vitest tests, pytest [-q] <test_*.py|*_test.py>, dart test <*_test.dart>, read-only Git, or exact workspace checks (cargo fmt --all -- --check, cargo clippy --workspace --all-targets -- -D warnings, cargo test --workspace, go test [-count=1] ./..., go vet ./..., swift test, dart analyze, dart test). Other commands or flags, shells, scripts, installs and publishing are forbidden.`,
      })
    }),
])

export const goalVerificationContractSchema = z
  .strictObject({
    version: z.literal(1),
    criteria: z
      .array(z.strictObject({ criterion: text, checks: z.array(goalVerificationCheckSchema).min(1).max(20) }))
      .min(1)
      .max(20),
  })
  .superRefine((contract, ctx) => {
    if (new Set(contract.criteria.map((entry) => entry.criterion)).size !== contract.criteria.length)
      ctx.addIssue({ code: "custom", message: "Assess each success criterion exactly once." })
    if (contract.criteria.reduce((sum, entry) => sum + entry.checks.length, 0) > 80)
      ctx.addIssue({ code: "custom", message: "Keep the verification contract within 80 executable checks." })
  })

export type GoalVerificationCheck = z.infer<typeof goalVerificationCheckSchema>
export type GoalVerificationContract = z.infer<typeof goalVerificationContractSchema>

export function validateGoalVerificationContract(input: unknown, successCriteria: string[]): GoalVerificationContract {
  const contract = goalVerificationContractSchema.parse(input)
  if (
    !successCriteria.length ||
    new Set(successCriteria).size !== successCriteria.length ||
    contract.criteria.length !== successCriteria.length ||
    contract.criteria.some((entry) => !successCriteria.includes(entry.criterion))
  )
    throw new Error(
      "Verification must cover every original success criterion exactly once. Preserve the original criterion text and provide executable evidence checks.",
    )
  return contract
}

export function goalVerificationContractDigest(contract: GoalVerificationContract): string {
  return createHash("sha256")
    .update(JSON.stringify(goalVerificationContractSchema.parse(contract)))
    .digest("hex")
}
