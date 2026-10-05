import { describe, expect, it, vi } from "vitest"
import { collectContainerObservation } from "./container-observation"
import { ContainerCommandError, type ContainerCommandExecutor } from "./container-observation-command"
import { containerObservationPolicySchema, containerTargetHealthy } from "./container-observation-policy"

const now = () => new Date("2026-10-06T00:00:00Z")
const policy = containerObservationPolicySchema.parse({
  targets: [
    { id: "service", kind: "kubernetes", namespace: "production", pod: "api-abc", container: "api", context: "prod" },
  ],
})
function pod(extra: Record<string, unknown> = {}, limits: Record<string, string> = { cpu: "500m", memory: "100Mi" }) {
  return {
    metadata: { uid: "pod-uid", name: "api-abc", namespace: "production" },
    status: {
      containerStatuses: [
        {
          name: "api",
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: "2026-10-05T23:55:00Z" } },
          ...extra,
        },
      ],
    },
    spec: {
      containers: [{ name: "api", env: [{ name: "API_SECRET", value: "never-store-env" }], resources: { limits } }],
    },
  }
}
function metrics(extra: Record<string, unknown> = {}) {
  return {
    metadata: { name: "api-abc", namespace: "production" },
    timestamp: now().toISOString(),
    window: "30s",
    containers: [{ name: "api", usage: { cpu: "250000000n", memory: "50Mi" } }],
    ...extra,
  }
}
function fake(
  document: unknown = pod(),
  logs = "INFO ready",
  resourceMetrics: unknown = metrics(),
  previousLogs = "ERROR prior crash",
) {
  return vi.fn<ContainerCommandExecutor>(async (command) => ({
    stdout: command.args.includes("--raw")
      ? JSON.stringify(resourceMetrics)
      : command.args.includes("get")
        ? JSON.stringify(document)
        : command.args.includes("--previous=true")
          ? previousLogs
          : logs,
    stderr: "",
  }))
}

describe("read-only Kubernetes container observation", () => {
  it("reduces the explicit selected container state without retaining spec, env or unrelated containers", async () => {
    const document = pod()
    document.status.containerStatuses.push({
      name: "sidecar",
      ready: false,
      restartCount: 3,
      state: { running: { startedAt: "old" } },
    })
    const execute = fake(document)
    const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    expect(snapshot.results[0]).toMatchObject({
      status: "collected",
      identity: "pod-uid/api",
      state: "running",
      ready: true,
      issues: [],
    })
    const retained = JSON.stringify(snapshot)
    expect(retained).not.toContain("never-store-env")
    expect(retained).not.toContain("sidecar")
    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls[0]?.[0].args).toEqual([
      "--context",
      "prod",
      "--namespace",
      "production",
      "--request-timeout",
      "10s",
      "get",
      "pod",
      "api-abc",
      "-o",
      "json",
    ])
    expect(execute.mock.calls[1]?.[0].args).toContain("--container")
    expect(execute.mock.calls[1]?.[0].args).toContain("--tail=50")
    expect(execute.mock.calls[1]?.[0].args).toContain("--since=300s")
    expect(execute.mock.calls[1]?.[0].args).toContain("--limit-bytes=65536")
    expect(execute.mock.calls[1]?.[0].args).not.toContain("--previous=true")
  })

  it("handles current CrashLoop and collects previous logs with explicit bounded requests", async () => {
    const execute = fake(
      pod({
        ready: false,
        restartCount: 4,
        state: { waiting: { reason: "CrashLoopBackOff", message: "token=must-redact" } },
        lastState: { terminated: { exitCode: 1 } },
      }),
    )
    const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    expect(snapshot.results[0]).toMatchObject({
      state: "waiting",
      ready: false,
      issues: ["not-running", "restarting", "log-error"],
      logsAvailable: true,
    })
    expect(execute).toHaveBeenCalledTimes(4)
    expect(execute.mock.calls[2]?.[0].args).toContain("--previous=true")
    expect(JSON.stringify(snapshot)).not.toContain("must-redact")
  })

  it("ignores historical lastState OOM until a fresh restart and does not repeatedly fetch historical logs", async () => {
    const firstExecute = fake(
      pod({ restartCount: 8, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } }),
    )
    const first = await collectContainerObservation(policy, undefined, { now, env: {}, execute: firstExecute })
    expect(first.results[0]).toMatchObject({ restartCount: 8, oomKilled: false, issues: [] })
    expect(firstExecute).toHaveBeenCalledTimes(3)
    const restarted = await collectContainerObservation(policy, first, {
      now,
      env: {},
      execute: fake(
        pod({ restartCount: 9, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } }),
        "INFO running",
        metrics(),
        "INFO restarted",
      ),
    })
    expect(restarted.results[0]?.issues).toEqual(["restart-increase", "oom-killed"])
    const nextExecute = fake(
      pod({ restartCount: 9, lastState: { terminated: { exitCode: 137, reason: "OOMKilled" } } }),
    )
    const next = await collectContainerObservation(policy, restarted, { now, env: {}, execute: nextExecute })
    expect(next.results[0]?.issues).toEqual([])
    expect(nextExecute).toHaveBeenCalledTimes(3)
  })

  it("observes terminated OOM and running but unready containers as unresolved incidents", async () => {
    const oom = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(pod({ ready: false, state: { terminated: { exitCode: 137, reason: "OOMKilled" } } })),
    })
    expect(oom.results[0]).toMatchObject({
      state: "terminated",
      exitCode: 137,
      oomKilled: true,
      issues: ["not-running", "oom-killed"],
    })
    const unready = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(pod({ ready: false })),
    })
    expect(unready.results[0]?.issues).toEqual(["unhealthy"])
  })

  it("computes percentages from fresh actual usage and the corresponding selected container limits", async () => {
    const execute = fake()
    const snapshot = await collectContainerObservation(
      { ...policy, cpu_percent_threshold: 40, memory_percent_threshold: 40 },
      undefined,
      { now, env: {}, execute },
    )
    expect(snapshot.results[0]).toMatchObject({
      cpuPercent: 50,
      memoryPercent: 50,
      statsAvailable: true,
      issues: ["cpu-high", "memory-high"],
    })
    expect(execute.mock.calls[2]?.[0].args).toContain("/apis/metrics.k8s.io/v1beta1/namespaces/production/pods/api-abc")
    expect(execute.mock.calls[2]?.[0].args).toContain("--raw")
  })

  it("does not fabricate statistics without resource limits or metrics-server access", async () => {
    const execute = fake(pod({}, {}))
    const noLimits = await collectContainerObservation({ ...policy, cpu_percent_threshold: 80 }, undefined, {
      now,
      env: {},
      execute,
    })
    expect(noLimits.results[0]).toMatchObject({ statsAvailable: false })
    expect(noLimits.results[0]?.cpuPercent).toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(3)
    const base = fake()
    const noServer: ContainerCommandExecutor = async (command) => {
      if (command.args.includes("--raw")) throw new ContainerCommandError("failed")
      return base(command)
    }
    const snapshot = await collectContainerObservation({ ...policy, memory_percent_threshold: 90 }, undefined, {
      now,
      env: {},
      execute: noServer,
    })
    expect(snapshot.results[0]).toMatchObject({ statsAvailable: false })
    expect(snapshot.results[0]?.memoryPercent).toBeUndefined()
    const result = snapshot.results[0]
    expect(result ? containerTargetHealthy(result) : false).toBe(false)
  })

  it("rejects stale, future, missing, oversized-window and cross-target resource metrics", async () => {
    for (const document of [
      metrics({ timestamp: "2026-10-05T00:00:00Z" }),
      metrics({ timestamp: "2026-10-06T00:01:00Z" }),
      metrics({ timestamp: undefined }),
      metrics({ window: "600s" }),
      metrics({ window: "invalid" }),
      metrics({ metadata: { name: "other", namespace: "production" } }),
      metrics({ containers: [] }),
    ]) {
      const snapshot = await collectContainerObservation({ ...policy, cpu_percent_threshold: 80 }, undefined, {
        now,
        env: {},
        execute: fake(pod(), "INFO healthy", document),
      })
      expect(snapshot.results[0]).toMatchObject({ statsAvailable: false })
      expect(snapshot.results[0]?.cpuPercent).toBeUndefined()
    }
  })

  it("rejects unavailable pods, duplicate status entries and mismatched namespace/name without echoing raw responses", async () => {
    const wrongName = pod()
    wrongName.metadata.name = "other"
    const wrongNamespace = pod()
    wrongNamespace.metadata.namespace = "other"
    const duplicate = pod()
    duplicate.status.containerStatuses.push({
      ...duplicate.status.containerStatuses[0],
      name: "api",
      ready: true,
      restartCount: 0,
      state: { running: { startedAt: "2026-10-05T23:55:00Z" } },
    })
    for (const document of [
      wrongName,
      wrongNamespace,
      duplicate,
      { metadata: { name: "api-abc", namespace: "production", uid: "pod-uid" }, status: { containerStatuses: [] } },
      { secret: "never-store-env" },
    ]) {
      const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute: fake(document) })
      expect(snapshot.results[0]?.status).toBe("unavailable")
      expect(JSON.stringify(snapshot)).not.toContain("never-store-env")
    }
  })

  it("requires previous-log evidence for a current restarted failure instead of claiming recovery", async () => {
    const base = fake(pod({ ready: false, restartCount: 1, state: { waiting: { reason: "CrashLoopBackOff" } } }))
    const execute: ContainerCommandExecutor = async (command) => {
      if (command.args.includes("--previous=true")) throw new ContainerCommandError("failed")
      return base(command)
    }
    const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    expect(snapshot.results[0]).toMatchObject({ logsAvailable: false, issues: ["not-running", "restarting"] })
    expect(snapshot.results[0]?.reason).toContain("Logs unavailable")
  })

  it("discards mixed evidence when the pod UID or selected container status changes during collection", async () => {
    const changedUid = pod()
    changedUid.metadata.uid = "new-pod-uid"
    for (const final of [
      changedUid,
      pod({ ready: false }),
      pod({ restartCount: 1 }),
      pod({ containerID: "new-runtime-id" }),
      pod({ state: { waiting: { reason: "CrashLoopBackOff" } } }),
    ]) {
      let reads = 0
      const execute: ContainerCommandExecutor = async (command) => {
        if (command.args.includes("get")) {
          reads += 1
          return { stdout: JSON.stringify(reads === 1 ? pod() : final), stderr: "" }
        }
        return { stdout: "INFO healthy", stderr: "" }
      }
      const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
      expect(snapshot.results[0]?.status).toBe("unavailable")
      expect(snapshot.results[0]?.identity).toBeUndefined()
      expect(snapshot.results[0]?.logExcerpt).toBeUndefined()
    }
  })
})
