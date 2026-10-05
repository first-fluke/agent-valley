import { z } from "zod"

export const missionIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,79}$/)
const requestId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
  .optional()
const budgets = {
  runs: z.number().int().min(1).max(2_000).optional(),
  duration: z.number().int().min(1).max(604_800).optional(),
  cost: z.number().finite().positive().optional(),
}
const continuousControls = {
  cycles: z.number().int().min(1).max(1_000_000).optional(),
  interval: z.number().int().min(1).max(86_400).optional(),
}
export const mcpOrderSchema = z
  .strictObject({
    workspace: z.string().min(1).max(4_096).optional(),
    goal: z.string().trim().min(1).max(32_000),
    requestId,
    verify: z.string().max(32_000).optional(),
    parallel: z.number().int().min(1).max(8).optional(),
    once: z.boolean().optional(),
    ...continuousControls,
    ...budgets,
  })
  .superRefine((input, context) => {
    if (input.once)
      for (const key of ["cycles", "interval"] as const)
        if (input[key] !== undefined)
          context.addIssue({
            code: "custom",
            message: `${key} applies to continuous orders. Omit it when once is true.`,
            path: [key],
          })
  })
export const mcpResumeSchema = z.strictObject({
  missionId: missionIdSchema,
  requestId,
  retry: z.boolean().optional(),
  rounds: z.number().int().min(1).max(50).optional(),
  ...budgets,
})
export type McpOrderInput = z.infer<typeof mcpOrderSchema>
export type McpResumeInput = z.infer<typeof mcpResumeSchema>
export const mcpOperateSchema = z.strictObject({
  charter: z.string().trim().min(1).max(32_000),
  requestId,
  ...continuousControls,
  verify: z.string().max(32_000).optional(),
  parallel: z.number().int().min(1).max(8).optional(),
  ...budgets,
})
export const mcpOperationResumeSchema = z.strictObject({ operationId: missionIdSchema, requestId })
export type McpOperateInput = z.infer<typeof mcpOperateSchema>
export type McpOperationResumeInput = z.infer<typeof mcpOperationResumeSchema>
export interface McpReportResult extends Record<string, unknown> {
  missionId: string
  markdown: string
}
export interface MissionApiPort {
  operate?(input: McpOperateInput): Promise<Record<string, unknown>>
  operations?(): Promise<Record<string, unknown>>
  operationStatus?(id: string): Promise<Record<string, unknown>>
  operationReport?(id: string): Promise<Record<string, unknown>>
  operationResume?(input: McpOperationResumeInput): Promise<Record<string, unknown>>
  operationCancel?(id: string): Promise<Record<string, unknown>>
  order(input: McpOrderInput): Promise<Record<string, unknown>>
  list(): Promise<Record<string, unknown>>
  status(missionId: string): Promise<Record<string, unknown>>
  report(missionId: string): Promise<McpReportResult>
  resume(input: McpResumeInput): Promise<Record<string, unknown>>
  cancel(missionId: string): Promise<Record<string, unknown>>
  close(): Promise<void>
}
export interface AvMcpOptions {
  workspace: string
  env?: NodeJS.ProcessEnv
  diagnostic?: (message: string) => void
}

export function missionReportUri(missionId: string): string {
  return `av://missions/${missionIdSchema.parse(missionId)}/report`
}
