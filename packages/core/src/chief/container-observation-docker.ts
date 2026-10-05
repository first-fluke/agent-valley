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

// Select individual state fields; full inspect includes environment variables and secret mounts.
const inspectFormat =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Status":{{json .State.Status}},"Running":{{json .State.Running}},"Restarting":{{json .State.Restarting}},"OOMKilled":{{json .State.OOMKilled}},"ExitCode":{{json .State.ExitCode}},"Error":{{json .State.Error}},"Health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}""{{end}},"RestartCount":{{json .RestartCount}}}'
const inspectionSchema = z.strictObject({
  Id: z.string().regex(/^[a-f0-9]{12,64}$/),
  Name: z.string().min(1).max(200),
  Status: z.enum(["created", "running", "paused", "restarting", "removing", "exited", "dead"]),
  Running: z.boolean(),
  Restarting: z.boolean(),
  OOMKilled: z.boolean(),
  ExitCode: z.number().int(),
  Error: z.string(),
  Health: z.enum(["", "starting", "healthy", "unhealthy"]),
  RestartCount: z.number().int().nonnegative(),
})
const statsSchema = z.object({
  ID: z.string().regex(/^[a-f0-9]{12,64}$/),
  Name: z.string(),
  CPUPerc: z.string(),
  MemPerc: z.string(),
})

function percent(value: string): number {
  if (!/^\d+(?:\.\d+)?%$/.test(value.trim())) throw new Error("Invalid percentage")
  const number = Number(value.trim().slice(0, -1))
  if (!Number.isFinite(number)) throw new Error("Invalid percentage")
  return number
}

export async function observeDockerContainer(ctx: ContainerAdapterContext): Promise<CollectedContainerResult> {
  if (ctx.target.kind !== "docker") throw new Error("Unexpected container adapter")
  const target = ctx.target
  const prefix = target.context ? ["--context", target.context] : []
  const inspected = await ctx.run([...prefix, "container", "inspect", "--format", inspectFormat, target.container])
  const state = inspectionSchema.parse(JSON.parse(inspected.stdout))
  const name = state.Name.replace(/^\//, "")
  if (
    name !== target.container &&
    !(/^[a-f0-9]{12,64}$/.test(target.container) && state.Id.startsWith(target.container))
  )
    throw new Error("Mismatched container identity")
  const running = state.Running && state.Status === "running" && !state.Restarting
  const result: CollectedContainerResult = {
    targetId: target.id,
    kind: target.kind,
    status: "collected",
    identity: state.Id,
    state: running ? "running" : ["exited", "dead"].includes(state.Status) ? "terminated" : "waiting",
    ready: running && !["unhealthy", "starting"].includes(state.Health),
    health: state.Health || undefined,
    restartCount: state.RestartCount,
    exitCode: running ? undefined : state.ExitCode,
    oomKilled: state.OOMKilled,
    issues: [],
  }
  if (!running) result.issues.push("not-running")
  if (state.Restarting || state.Status === "restarting") result.issues.push("restarting")
  if (state.Health === "unhealthy") result.issues.push("unhealthy")
  const freshRestart = hasFreshContainerRestart(result, ctx.previous)
  if (freshRestart) result.issues.push("restart-increase")
  if (state.OOMKilled && (!running || freshRestart)) result.issues.push("oom-killed")
  if (state.Error && !running) result.reason = sanitizeContainerText(state.Error, ctx.env).slice(0, 1_000)
  try {
    const logs = await ctx.run([
      ...prefix,
      "logs",
      "--timestamps",
      "--tail",
      String(ctx.policy.log_tail),
      "--since",
      `${ctx.policy.log_since_sec}s`,
      state.Id,
    ])
    setContainerLogs(result, [logs.stdout, logs.stderr].filter(Boolean).join("\n"), ctx)
  } catch (error) {
    result.logsAvailable = false
    addContainerReason(result, `Logs unavailable. ${containerObservationFailure(error)}`)
  }
  if (containerStatsRequested(ctx.policy)) {
    try {
      const stats = await ctx.run([...prefix, "stats", "--no-stream", "--format", "{{json .}}", state.Id])
      const parsed = statsSchema.parse(JSON.parse(stats.stdout))
      if (parsed.Name.replace(/^\//, "") !== name || !state.Id.startsWith(parsed.ID))
        throw new Error("Mismatched statistics target")
      result.cpuPercent = percent(parsed.CPUPerc)
      result.memoryPercent = percent(parsed.MemPerc)
      result.statsAvailable = true
      addContainerResourceIssues(result, ctx.policy)
    } catch (error) {
      result.statsAvailable = false
      addContainerReason(result, `Resource statistics unavailable. ${containerObservationFailure(error)}`)
    }
  }
  const finalRaw = await ctx.run([...prefix, "container", "inspect", "--format", inspectFormat, state.Id])
  const finalState = inspectionSchema.parse(JSON.parse(finalRaw.stdout))
  if (JSON.stringify(finalState) !== JSON.stringify(state)) throw new Error("Container changed during observation")
  return result
}
