import { z } from "zod"

const reportPath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split(/[\\/]/).includes("..") && path.includes("{{attempt.id}}"),
    "task.report_path must stay in the workspace and contain {{attempt.id}}",
  )

export const taskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code") }),
  z.object({ kind: z.literal("analysis"), report_path: reportPath }),
])

export const resolvedTaskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code") }),
  z.object({ kind: z.literal("analysis"), reportPath }),
])

export type ResolvedTask = z.infer<typeof resolvedTaskSchema>
