import { z } from "zod"

const targetName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, "Use a container name or ID, without CLI flags.")
const contextName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/, "Use an existing CLI context name.")
  .refine((value) => !value.includes("://"), "Use a context name, not a URL or credentials.")
const dnsName = z.string().regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/, "Use an explicit Kubernetes name.")
const timestamp = z.string().datetime({ offset: true })
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const containerObservationTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id: targetName, kind: z.literal("docker"), container: targetName, context: contextName.optional() }),
  z.strictObject({
    id: targetName,
    kind: z.literal("kubernetes"),
    namespace: dnsName,
    pod: dnsName,
    container: targetName,
    context: contextName.optional(),
  }),
])
export const containerObservationPolicySchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    targets: z.array(containerObservationTargetSchema).min(1).max(20),
    poll_interval_sec: z.number().int().min(1).max(3_600).default(30),
    timeout_ms: z.number().int().min(100).max(60_000).default(10_000),
    max_output_bytes: z.number().int().min(1_024).max(1_048_576).default(65_536),
    log_tail: z.number().int().min(1).max(200).default(50),
    log_since_sec: z.number().int().min(1).max(86_400).default(300),
    cpu_percent_threshold: z.number().finite().positive().max(10_000).optional(),
    memory_percent_threshold: z.number().finite().positive().max(100).optional(),
  })
  .superRefine((policy, ctx) => {
    if (new Set(policy.targets.map((target) => target.id)).size !== policy.targets.length)
      ctx.addIssue({ code: "custom", path: ["targets"], message: "Container observation target IDs must be unique." })
  })
export type ContainerObservationTarget = z.output<typeof containerObservationTargetSchema>
export type ContainerObservationPolicy = z.output<typeof containerObservationPolicySchema>

export const containerObservationResultSchema = z.strictObject({
  targetId: targetName,
  kind: z.enum(["docker", "kubernetes"]),
  status: z.enum(["collected", "unavailable"]),
  identity: z.string().min(1).max(500).optional(),
  state: z.enum(["running", "waiting", "terminated", "unknown"]).optional(),
  ready: z.boolean().optional(),
  health: z.string().max(100).optional(),
  exitCode: z.number().int().optional(),
  restartCount: z.number().int().nonnegative().optional(),
  oomKilled: z.boolean().optional(),
  cpuPercent: z.number().finite().nonnegative().optional(),
  memoryPercent: z.number().finite().nonnegative().optional(),
  logExcerpt: z.string().max(8_192).optional(),
  logsAvailable: z.boolean().optional(),
  statsAvailable: z.boolean().optional(),
  reason: z.string().max(1_000).optional(),
  issues: z
    .array(
      z.enum([
        "not-running",
        "unhealthy",
        "oom-killed",
        "restarting",
        "restart-increase",
        "log-error",
        "cpu-high",
        "memory-high",
      ]),
    )
    .max(8),
  fingerprint: digest,
})
export type ContainerObservationResult = z.output<typeof containerObservationResultSchema>

export const containerObservationSnapshotSchema = z.strictObject({
  collectedAt: timestamp,
  nextPollAt: timestamp,
  fingerprint: digest,
  results: z.array(containerObservationResultSchema).max(20),
})
export type ContainerObservationSnapshot = z.output<typeof containerObservationSnapshotSchema>

export function containerTargetHealthy(result: ContainerObservationResult): boolean {
  return (
    result.status === "collected" &&
    result.state === "running" &&
    result.ready === true &&
    result.logsAvailable !== false &&
    result.statsAvailable !== false &&
    result.issues.length === 0
  )
}
