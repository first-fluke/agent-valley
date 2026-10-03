import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"
import { z } from "zod"

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

export function verificationCommandTestPaths(program: string, args: string[]): string[] {
  if (program === "bun" && args[0] === "test") return args.slice(1)
  if (program === "node" && args[0] === "--test") return args.slice(1)
  if (program === "node" && args[0] === "node_modules/vitest/vitest.mjs" && args[1] === "run") return args.slice(2)
  return []
}

/** Package scripts, shells, interpreter eval flags and implicit discovery are excluded. */
export function safeVerificationCommand(program: string, args: string[]): boolean {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) return false
  const tests = verificationCommandTestPaths(program, args)
  if (tests.length) return tests.every((name) => testPath(name, program === "node" && args[0] === "--test"))
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
    contains: z.array(text).min(1).max(10).optional(),
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
    equals: z.union([z.string().max(4_000), z.number().finite(), z.boolean(), z.null()]),
  }),
  z
    .strictObject({
      kind: z.literal("command"),
      program: z.enum(["git", "node", "bun"]),
      args: z.array(z.string().min(1).max(1_024)).min(1).max(30),
      timeoutMs: z.number().int().min(100).max(300_000).default(120_000),
      stdoutIncludes: z.array(text).min(1).max(10).optional(),
    })
    .refine((check) => safeVerificationCommand(check.program, check.args), {
      message:
        "Use explicit test files with node --test, bun test, installed Vitest run, or a read-only Git check. Shells, scripts, builds, installs and publishing are forbidden.",
    }),
])

export const goalVerificationContractSchema = z
  .strictObject({
    version: z.literal(1),
    criteria: z
      .array(z.strictObject({ criterion: text, checks: z.array(goalVerificationCheckSchema).min(1).max(10) }))
      .min(1)
      .max(20),
  })
  .superRefine((contract, ctx) => {
    if (new Set(contract.criteria.map((entry) => entry.criterion)).size !== contract.criteria.length)
      ctx.addIssue({ code: "custom", message: "Assess each success criterion exactly once." })
    if (contract.criteria.reduce((sum, entry) => sum + entry.checks.length, 0) > 40)
      ctx.addIssue({ code: "custom", message: "Keep the verification contract within 40 executable checks." })
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
