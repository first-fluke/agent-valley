import { z } from "zod"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
const bounded = z.string().trim().min(1).max(2_000)
const path = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"))

export const skillCompatibilityConfigSchema = z.strictObject({
  report_path: path,
  max_age_hours: z.number().finite().positive().max(8_760).default(168),
  mode: z.enum(["warn", "require"]),
})

export const skillCompatibilityPolicySchema = z.strictObject({
  reportPath: path,
  maxAgeHours: z.number().finite().positive().max(8_760),
  mode: z.enum(["warn", "require"]),
})
export type SkillCompatibilityPolicy = z.infer<typeof skillCompatibilityPolicySchema>

export const omaConfigSchema = z.strictObject({
  mode: z.enum(["off", "strict"]).default("off"),
  skill_compatibility: skillCompatibilityConfigSchema.optional(),
})

export const matrixSkillSchema = z.object({
  name,
  hash,
  caseId: bounded,
  requiredFiles: z.array(path).min(1).max(500),
  missingFiles: z.array(path).max(500),
  excludedReferences: z.array(z.object({ path, reason: bounded })).max(500),
})
export const matrixReportSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("skill-compatibility-matrix"),
  mode: z.enum(["plan", "live"]),
  status: z.enum(["planned", "completed", "cancelled", "interrupted"]),
  createdAt: z.iso.datetime(),
  omaVersion: bounded,
  host: z.object({ platform: bounded, arch: bounded, node: bounded }),
  suiteHash: hash,
  sourceKind: z.enum(["synthetic", "installed"]),
  delivery: z.enum(["native", "injected"]),
  auditScope: z.enum(["fixture-contract", "read-reference"]),
  protocolVersion: z.literal("oma-skill-matrix-v2"),
  bundle: z.object({ hash, skills: z.array(matrixSkillSchema).min(1).max(100) }).optional(),
  cases: z.array(z.object({ id: bounded, skill: name })).max(100),
  models: z.object({ claude: bounded.nullable(), codex: bounded.nullable() }),
  cells: z
    .array(
      z.object({
        caseId: bounded,
        skill: name,
        vendor: z.enum(["claude", "codex"]),
        status: z.enum(["pass", "fail", "unverifiable", "error"]),
        contentHash: hash,
        checks: z
          .array(
            z.object({
              id: bounded,
              status: z.enum(["pass", "fail", "unverifiable"]),
              detail: bounded,
              proof: z.enum(["read", "canary"]).optional(),
            }),
          )
          .max(1_000),
        nativeActivation: z.enum(["observed", "unobserved"]),
        cliVersion: z
          .string()
          .regex(/^[\w .()+/-]{1,160}$/)
          .nullable(),
        model: bounded.nullable(),
        durationMs: z.number().finite().nonnegative(),
      }),
    )
    .max(200),
})
export type SkillMatrixReport = z.infer<typeof matrixReportSchema>
export type MatrixSkill = z.infer<typeof matrixSkillSchema>

export interface MatrixRoute {
  actorType: string
  model?: string
}
export interface MatrixRouteResult extends MatrixRoute {
  status: "pass" | "fail" | "unknown"
  reason: string
}
export interface MatrixInspection {
  routes: MatrixRouteResult[]
  scope: "installed injected read-reference audit; not AV runtime or task-quality certification"
}
