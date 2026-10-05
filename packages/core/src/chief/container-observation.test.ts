import { describe, expect, it, vi } from "vitest"
import { collectContainerObservation } from "./container-observation"
import { ContainerCommandError, type ContainerCommandExecutor } from "./container-observation-command"
import { containerObservationPolicySchema, containerTargetHealthy } from "./container-observation-policy"

const now = () => new Date("2026-10-06T00:00:00Z")
const id = "a".repeat(64)
const policy = containerObservationPolicySchema.parse({
  targets: [{ id: "api", kind: "docker", container: "api", context: "orbstack" }],
})
const state = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    Id: id,
    Name: "/api",
    Status: "running",
    Running: true,
    Restarting: false,
    OOMKilled: false,
    ExitCode: 0,
    Error: "",
    Health: "healthy",
    RestartCount: 0,
    ...extra,
  })
function fake(
  inspection = state(),
  logs = "2026-10-06T00:00:00Z INFO service started",
  stats = { ID: id.slice(0, 12), Name: "api", CPUPerc: "10.50%", MemPerc: "30.00%" },
) {
  return vi.fn<ContainerCommandExecutor>(async (command) => ({
    stdout: command.args.includes("inspect")
      ? inspection
      : command.args.includes("stats")
        ? JSON.stringify(stats)
        : logs,
    stderr: "",
  }))
}

describe("read-only Docker container observation", () => {
  it("selects only safe fields, limits logs and does not gather stats without thresholds", async () => {
    const execute = fake()
    const snapshot = await collectContainerObservation(policy, undefined, { execute, now, env: {} })
    expect(snapshot).toMatchObject({ collectedAt: now().toISOString(), nextPollAt: "2026-10-06T00:00:30.000Z" })
    expect(snapshot.results[0] ? containerTargetHealthy(snapshot.results[0]) : false).toBe(true)
    expect(execute).toHaveBeenCalledTimes(3)
    const inspect = execute.mock.calls[0]?.[0]
    if (!inspect) throw new Error("Inspection was not called")
    expect(inspect.binary).toBe("docker")
    expect(inspect.args.slice(0, 5)).toEqual(["--context", "orbstack", "container", "inspect", "--format"])
    expect(inspect.args[5]).not.toMatch(/\.Config|\.Env|\.Mounts|json \.State\}/)
    expect(execute.mock.calls[1]?.[0].args).toEqual([
      "--context",
      "orbstack",
      "logs",
      "--timestamps",
      "--tail",
      "50",
      "--since",
      "300s",
      id,
    ])
    expect(JSON.stringify(snapshot)).not.toContain("State.Status")
  })

  it("ignores successful log changes, timestamps and below-threshold resource jitter in fingerprints", async () => {
    const thresholdPolicy = { ...policy, cpu_percent_threshold: 80, memory_percent_threshold: 90 }
    const first = await collectContainerObservation(thresholdPolicy, undefined, { now, env: {}, execute: fake() })
    const second = await collectContainerObservation(thresholdPolicy, first, {
      now: () => new Date(now().getTime() + 30_000),
      env: {},
      execute: fake(state(), "2026-10-06T00:00:30Z INFO request succeeded", {
        ID: id,
        Name: "api",
        CPUPerc: "75.1%",
        MemPerc: "85%",
      }),
    })
    expect(second.results[0]).toMatchObject({ cpuPercent: 75.1, memoryPercent: 85, statsAvailable: true })
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it("surfaces thresholds from actual Docker stats and rejects metrics for another container", async () => {
    const thresholdPolicy = { ...policy, cpu_percent_threshold: 10, memory_percent_threshold: 20 }
    const snapshot = await collectContainerObservation(thresholdPolicy, undefined, { now, env: {}, execute: fake() })
    expect(snapshot.results[0]?.issues).toEqual(["cpu-high", "memory-high"])
    const mismatched = await collectContainerObservation(thresholdPolicy, undefined, {
      now,
      env: {},
      execute: fake(state(), "", { ID: "b".repeat(12), Name: "elsewhere", CPUPerc: "1%", MemPerc: "1%" }),
    })
    expect(mismatched.results[0]).toMatchObject({ statsAvailable: false })
    expect(mismatched.results[0] ? containerTargetHealthy(mismatched.results[0]) : false).toBe(false)
  })

  it("records historical restart and OOM evidence without repeatedly declaring a current failure", async () => {
    const execute = fake(state({ RestartCount: 4, OOMKilled: true }))
    const first = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    expect(first.results[0]).toMatchObject({ restartCount: 4, oomKilled: true, issues: [] })
    const second = await collectContainerObservation(policy, first, {
      now,
      env: {},
      execute: fake(state({ RestartCount: 5, OOMKilled: true })),
    })
    expect(second.results[0]?.issues).toEqual(["restart-increase", "oom-killed"])
    const third = await collectContainerObservation(policy, second, {
      now,
      env: {},
      execute: fake(state({ RestartCount: 5, OOMKilled: true })),
    })
    expect(third.results[0]?.issues).toEqual([])
    expect(third.results[0] ? containerTargetHealthy(third.results[0]) : false).toBe(true)
    const recreated = await collectContainerObservation(policy, first, {
      now,
      env: {},
      execute: fake(state({ Id: "b".repeat(64), RestartCount: 20 })),
    })
    expect(recreated.results[0]?.issues).toEqual([])
  })

  it("reports current termination, OOM, unhealthy state and restart loops as incidents", async () => {
    const stopped = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(state({ Status: "exited", Running: false, ExitCode: 137, OOMKilled: true })),
    })
    expect(stopped.results[0]).toMatchObject({
      state: "terminated",
      exitCode: 137,
      issues: ["not-running", "oom-killed"],
    })
    const unhealthy = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(state({ Health: "unhealthy" })),
    })
    expect(unhealthy.results[0]).toMatchObject({ ready: false, issues: ["unhealthy"] })
    const restart = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(state({ Status: "restarting", Restarting: true })),
    })
    expect(restart.results[0]?.issues).toEqual(["not-running", "restarting"])
  })

  it("collects application stderr log errors, normalizes timestamps and exposes clues rather than root causes", async () => {
    const execute = vi.fn<ContainerCommandExecutor>(async (command) => ({
      stdout: command.args.includes("inspect") ? state() : "",
      stderr: command.args.includes("logs") ? "2026-10-06T00:00:00Z ERROR database connection refused" : "",
    }))
    const first = await collectContainerObservation(policy, undefined, { execute, now, env: {} })
    expect(first.results[0]?.issues).toEqual(["log-error"])
    expect(first.results[0]?.reason).toBeUndefined()
    const second = await collectContainerObservation(policy, first, {
      now,
      env: {},
      execute: fake(state(), "2026-10-06T00:00:30.123456789Z ERROR database connection refused"),
    })
    expect(first.fingerprint).toBe(second.fingerprint)
    const different = await collectContainerObservation(policy, second, {
      now,
      env: {},
      execute: fake(state(), "2026-10-06T00:00:30Z FATAL process aborted"),
    })
    expect(different.fingerprint).not.toBe(second.fingerprint)
    const zero = await collectContainerObservation(policy, undefined, {
      now,
      env: {},
      execute: fake(state(), "INFO no errors; errors=0; started without error"),
    })
    expect(zero.results[0]?.issues).toEqual([])
  })

  it("redacts credentials before bounding retained text, including env values, auth, URL queries and private keys", async () => {
    const secret = "container_fixture_secret"
    const logs = `${"x".repeat(9_000)}\nERROR password='hunter-two' authorization=Bearer abc-123\nERROR https://alice:password@host/path?sig=sas-secret&code=oauth-code\nERROR ${secret}\n-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----`
    const snapshot = await collectContainerObservation(policy, undefined, {
      now,
      execute: fake(state(), logs),
      env: { API_TOKEN: secret },
    })
    const retained = JSON.stringify(snapshot)
    for (const value of [
      secret,
      "hunter-two",
      "abc-123",
      "sas-secret",
      "oauth-code",
      "alice:password",
      "private-material",
    ])
      expect(retained).not.toContain(value)
    expect(snapshot.results[0]?.logExcerpt?.length).toBeLessThanOrEqual(8_192)
    expect(retained).toContain("redacted")
  })

  it("never echoes failure stderr, malformed response, a wrong target or missing daemon as healthy", async () => {
    const malicious = "credential-that-must-not-leak"
    for (const execute of [
      fake(`{truncated secret=${malicious}`),
      fake(state({ Name: "/other" })),
      vi.fn<ContainerCommandExecutor>(async () => {
        throw new Error(malicious)
      }),
      vi.fn<ContainerCommandExecutor>(async () => {
        throw new ContainerCommandError("missing-cli")
      }),
    ]) {
      const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
      expect(snapshot.results[0]?.status).toBe("unavailable")
      expect(snapshot.results[0] ? containerTargetHealthy(snapshot.results[0]) : false).toBe(false)
      expect(JSON.stringify(snapshot)).not.toContain(malicious)
    }
  })

  it("surfaces logs and statistics independently, with no recovery proof when either required source failed", async () => {
    const execute = vi.fn<ContainerCommandExecutor>(async (command) => {
      if (command.args.includes("inspect")) return { stdout: state(), stderr: "" }
      throw new ContainerCommandError("failed")
    })
    const snapshot = await collectContainerObservation({ ...policy, cpu_percent_threshold: 80 }, undefined, {
      now,
      env: {},
      execute,
    })
    expect(snapshot.results[0]).toMatchObject({
      status: "collected",
      state: "running",
      logsAvailable: false,
      statsAvailable: false,
    })
    expect(snapshot.results[0] ? containerTargetHealthy(snapshot.results[0]) : false).toBe(false)
  })

  it("caps the aggregate byte budget across status and logs, even for an injected executor", async () => {
    const snapshot = await collectContainerObservation({ ...policy, max_output_bytes: 1_024 }, undefined, {
      now,
      env: {},
      execute: fake(state(), "x".repeat(1_000)),
    })
    expect(snapshot.results[0]).toMatchObject({ status: "unavailable" })
    expect(snapshot.results[0]?.reason).toContain("output limit")
    expect(snapshot.results[0]?.logExcerpt).toBeUndefined()
  })

  it("uses finish time for next poll and supports disabled collection with no CLI calls", async () => {
    const execute = fake()
    const times = [now(), new Date(now().getTime() + 90_000)]
    const snapshot = await collectContainerObservation(policy, undefined, {
      now: () => times.shift() ?? now(),
      env: {},
      execute,
    })
    expect(snapshot.nextPollAt).toBe("2026-10-06T00:02:00.000Z")
    execute.mockClear()
    const disabled = await collectContainerObservation({ ...policy, enabled: false }, undefined, { now, execute })
    expect(disabled.results).toEqual([])
    expect(execute).not.toHaveBeenCalled()
  })

  it("rejects cross-target previous evidence and bad policy before any subprocess", async () => {
    const execute = fake()
    const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    execute.mockClear()
    await expect(collectContainerObservation(policy, { ...snapshot, results: [] }, { execute, now })).rejects.toThrow(
      "pinned target",
    )
    await expect(
      collectContainerObservation(
        { ...policy, targets: [{ id: "api", kind: "docker", container: "--all" }] },
        undefined,
        { execute, now },
      ),
    ).rejects.toThrow("av.yaml")
    expect(execute).not.toHaveBeenCalled()
  })

  it("cancels without executing a pre-aborted command", async () => {
    const execute = fake()
    const controller = new AbortController()
    controller.abort()
    const snapshot = await collectContainerObservation(policy, undefined, { execute, now, signal: controller.signal })
    expect(snapshot.results[0]?.reason).toContain("cancelled")
    expect(execute).not.toHaveBeenCalled()
  })

  it("pins subsequent reads to the immutable inspected ID and rejects a state change during observation", async () => {
    let inspections = 0
    const execute = vi.fn<ContainerCommandExecutor>(async (command) => {
      if (command.args.includes("inspect")) {
        inspections += 1
        return { stdout: state(inspections === 1 ? {} : { Health: "unhealthy" }), stderr: "" }
      }
      return { stdout: "INFO all requests served", stderr: "" }
    })
    const snapshot = await collectContainerObservation(policy, undefined, { now, env: {}, execute })
    expect(execute.mock.calls[0]?.[0].args.at(-1)).toBe("api")
    expect(execute.mock.calls[1]?.[0].args.at(-1)).toBe(id)
    expect(execute.mock.calls[2]?.[0].args.at(-1)).toBe(id)
    expect(snapshot.results[0]?.status).toBe("unavailable")
    expect(snapshot.results[0]?.ready).toBeUndefined()
    expect(snapshot.results[0]?.logExcerpt).toBeUndefined()
  })
})
