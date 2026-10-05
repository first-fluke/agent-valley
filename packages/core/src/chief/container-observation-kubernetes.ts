import { z } from "zod"
import {
  addContainerReason,
  addContainerResourceIssues,
  type CollectedContainerResult,
  type ContainerAdapterContext,
  containerObservationFailure,
  containerStatsRequested,
  hasFreshContainerRestart,
  setContainerLogs,
} from "./container-observation-adapter"
import { sanitizeContainerText } from "./container-observation-text"

const containerState = z.object({
  running: z.object({ startedAt: z.string().optional() }).optional(),
  waiting: z.object({ reason: z.string().optional(), message: z.string().optional() }).optional(),
  terminated: z
    .object({ exitCode: z.number().int(), reason: z.string().optional(), message: z.string().optional() })
    .optional(),
})
const podSchema = z.object({
  metadata: z.object({ uid: z.string().min(1).max(128), name: z.string(), namespace: z.string() }),
  status: z.object({
    containerStatuses: z.array(
      z.object({
        name: z.string(),
        ready: z.boolean(),
        restartCount: z.number().int().nonnegative(),
        containerID: z.string().max(200).optional(),
        state: containerState,
        lastState: containerState.optional(),
      }),
    ),
  }),
  spec: z
    .object({
      containers: z.array(
        z.object({
          name: z.string(),
          resources: z
            .object({ limits: z.object({ cpu: z.string().optional(), memory: z.string().optional() }).optional() })
            .optional(),
        }),
      ),
    })
    .optional(),
})
const metricsSchema = z.object({
  metadata: z.object({ name: z.string(), namespace: z.string() }),
  timestamp: z.string().datetime({ offset: true }),
  window: z.string(),
  containers: z.array(z.object({ name: z.string(), usage: z.object({ cpu: z.string(), memory: z.string() }) })),
})

function metricWindow(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)$/.exec(value)
  if (!match) throw new Error("Invalid metric window")
  const scale = ({ ns: 1e-6, us: 1e-3, ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as Record<string, number>)[
    match[2] ?? ""
  ]
  const duration = Number(match[1]) * (scale ?? 0)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("Invalid metric window")
  return duration
}

function quantity(value: string, cpu: boolean): number {
  const match = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(value)
  if (!match) throw new Error("Invalid resource quantity")
  const suffix = match[2] ?? ""
  const scale = cpu
    ? ({ "": 1, m: 1e-3, u: 1e-6, n: 1e-9 } as Record<string, number>)[suffix]
    : (
        {
          "": 1,
          K: 1e3,
          k: 1e3,
          M: 1e6,
          G: 1e9,
          T: 1e12,
          P: 1e15,
          E: 1e18,
          Ki: 2 ** 10,
          Mi: 2 ** 20,
          Gi: 2 ** 30,
          Ti: 2 ** 40,
          Pi: 2 ** 50,
          Ei: 2 ** 60,
        } as Record<string, number>
      )[suffix]
  if (scale === undefined) throw new Error("Unsupported resource quantity")
  const number = Number(match[1]) * scale
  if (!Number.isFinite(number) || number < 0) throw new Error("Invalid resource quantity")
  return number
}

async function observeResources(
  result: CollectedContainerResult,
  ctx: ContainerAdapterContext,
  prefix: string[],
  pod: z.output<typeof podSchema>,
): Promise<void> {
  if (ctx.target.kind !== "kubernetes") return
  const target = ctx.target
  try {
    const limits = pod.spec?.containers.find((container) => container.name === target.container)?.resources?.limits
    const cpuLimit = ctx.policy.cpu_percent_threshold === undefined ? undefined : quantity(limits?.cpu ?? "", true)
    const memoryLimit =
      ctx.policy.memory_percent_threshold === undefined ? undefined : quantity(limits?.memory ?? "", false)
    if (cpuLimit === 0 || memoryLimit === 0) throw new Error("Positive resource limit required")
    const raw = await ctx.run([
      ...prefix,
      "get",
      "--raw",
      `/apis/metrics.k8s.io/v1beta1/namespaces/${target.namespace}/pods/${target.pod}`,
    ])
    const metrics = metricsSchema.parse(JSON.parse(raw.stdout))
    const maxAge = Math.min(300_000, Math.max(30_000, ctx.policy.poll_interval_sec * 2_000))
    const age = ctx.now().getTime() - Date.parse(metrics.timestamp)
    if (age < -1_000 || age > maxAge || metricWindow(metrics.window) > maxAge) throw new Error("Stale resource metrics")
    if (metrics.metadata.name !== target.pod || metrics.metadata.namespace !== target.namespace)
      throw new Error("Mismatched metrics target")
    const matching = metrics.containers.filter((container) => container.name === target.container)
    if (matching.length !== 1 || !matching[0]) throw new Error("Missing selected container metrics")
    const cpuPercent = cpuLimit === undefined ? undefined : (quantity(matching[0].usage.cpu, true) / cpuLimit) * 100
    const memoryPercent =
      memoryLimit === undefined ? undefined : (quantity(matching[0].usage.memory, false) / memoryLimit) * 100
    if ([cpuPercent, memoryPercent].some((value) => value !== undefined && !Number.isFinite(value)))
      throw new Error("Invalid resource percentage")
    result.cpuPercent = cpuPercent
    result.memoryPercent = memoryPercent
    result.statsAvailable = true
    addContainerResourceIssues(result, ctx.policy)
  } catch (error) {
    result.statsAvailable = false
    addContainerReason(
      result,
      `Resource statistics unavailable. Configure positive limits and check metrics-server access, timestamps and windows. ${containerObservationFailure(error)}`,
    )
  }
}

export async function observeKubernetesContainer(ctx: ContainerAdapterContext): Promise<CollectedContainerResult> {
  if (ctx.target.kind !== "kubernetes") throw new Error("Unexpected container adapter")
  const target = ctx.target
  const prefix = [
    ...(target.context ? ["--context", target.context] : []),
    "--namespace",
    target.namespace,
    "--request-timeout",
    `${Math.max(1, Math.ceil(ctx.policy.timeout_ms / 1_000))}s`,
  ]
  const raw = await ctx.run([...prefix, "get", "pod", target.pod, "-o", "json"])
  const pod = podSchema.parse(JSON.parse(raw.stdout))
  if (pod.metadata.name !== target.pod || pod.metadata.namespace !== target.namespace)
    throw new Error("Mismatched pod identity")
  const matching = pod.status.containerStatuses.filter((item) => item.name === target.container)
  if (matching.length !== 1 || !matching[0]) throw new Error("Missing selected container status")
  const status = matching[0]
  const stateKeys = [status.state.running, status.state.waiting, status.state.terminated].filter(Boolean)
  if (stateKeys.length !== 1) throw new Error("Invalid container state")
  const reason = status.state.waiting?.reason ?? status.state.terminated?.reason
  const message = status.state.waiting?.message ?? status.state.terminated?.message
  const result: CollectedContainerResult = {
    targetId: target.id,
    kind: target.kind,
    status: "collected",
    // Pod UID + selected container name identify restart counters across recreated Pods.
    identity: `${pod.metadata.uid}/${target.container}`,
    state: status.state.running ? "running" : status.state.waiting ? "waiting" : "terminated",
    ready: status.ready,
    restartCount: status.restartCount,
    exitCode: status.state.terminated?.exitCode,
    oomKilled: reason === "OOMKilled",
    reason:
      [reason, message]
        .filter(Boolean)
        .map((text) => sanitizeContainerText(text as string, ctx.env))
        .join(": ")
        .slice(0, 1_000) || undefined,
    issues: [],
  }
  if (!status.state.running) result.issues.push("not-running")
  if (status.state.running && !status.ready) result.issues.push("unhealthy")
  if (reason === "CrashLoopBackOff") result.issues.push("restarting")
  const freshRestart = hasFreshContainerRestart(result, ctx.previous)
  if (freshRestart) result.issues.push("restart-increase")
  if (reason === "OOMKilled" || (freshRestart && status.lastState?.terminated?.reason === "OOMKilled")) {
    result.oomKilled = true
    result.issues.push("oom-killed")
  }
  const logArgs = [
    ...prefix,
    "logs",
    target.pod,
    "--container",
    target.container,
    "--timestamps=true",
    `--tail=${ctx.policy.log_tail}`,
    `--since=${ctx.policy.log_since_sec}s`,
    `--limit-bytes=${ctx.policy.max_output_bytes}`,
  ]
  try {
    const current = await ctx.run(logArgs)
    const logs = [current.stdout]
    if (freshRestart || (status.restartCount > 0 && !status.state.running)) {
      const previous = await ctx.run([...logArgs, "--previous=true"])
      logs.push(previous.stdout)
    }
    setContainerLogs(result, logs.join("\n"), ctx)
  } catch (error) {
    result.logsAvailable = false
    addContainerReason(result, `Logs unavailable. ${containerObservationFailure(error)}`)
  }
  if (containerStatsRequested(ctx.policy)) await observeResources(result, ctx, prefix, pod)
  const finalRaw = await ctx.run([...prefix, "get", "pod", target.pod, "-o", "json"])
  const finalPod = podSchema.parse(JSON.parse(finalRaw.stdout))
  const finalStatuses = finalPod.status.containerStatuses.filter((item) => item.name === target.container)
  const finalStatus = finalStatuses[0]
  if (
    finalPod.metadata.uid !== pod.metadata.uid ||
    finalPod.metadata.name !== target.pod ||
    finalPod.metadata.namespace !== target.namespace ||
    finalStatuses.length !== 1 ||
    !finalStatus ||
    finalStatus.containerID !== status.containerID ||
    finalStatus.ready !== status.ready ||
    finalStatus.restartCount !== status.restartCount ||
    JSON.stringify(finalStatus.state) !== JSON.stringify(status.state)
  ) {
    throw new Error("Pod or selected container changed during observation")
  }
  return result
}
