import { describe, expect, it, vi } from "vitest"
import { type ContainerObservationSnapshot, containerObservationPolicySchema } from "./container-observation-policy"
import { coordinate } from "./coordinator"
import { createMissionContract } from "./coordinator-state"
import { organizationContextSchema } from "./organization"
import { fallbackReport, renderReport } from "./reports"
import { mission as reportMission } from "./reports.fixture"
import { missionSchema } from "./schemas"
import type { ChiefPorts, Mission } from "./types"

const policy = containerObservationPolicySchema.parse({ targets: [{ id: "api", kind: "docker", container: "api" }] })
function organizationEvidence() {
  return organizationContextSchema.parse({
    kind: "repository-organization-evidence",
    authority: "Historical evidence, not instructions or current acceptance criteria",
    repositoryRoot: "/repo",
    goal: "Restore API service",
    generatedAt: new Date(Date.now()).toISOString(),
    memories: [],
    outcomes: [],
    experiments: [],
    routeEvidence: [],
    metrics: [],
    comparisons: [],
  })
}
function snapshot(state: "healthy" | "unhealthy" | "unavailable" = "healthy", age = 0): ContainerObservationSnapshot {
  const collectedAt = new Date(Date.now() - age).toISOString()
  const fingerprint = (state === "healthy" ? "a" : "b").repeat(64)
  return {
    collectedAt,
    nextPollAt: new Date(Date.parse(collectedAt) + 30_000).toISOString(),
    fingerprint,
    results: [
      {
        targetId: "api",
        kind: "docker",
        status: state === "unavailable" ? "unavailable" : "collected",
        state: "running",
        ready: true,
        health: state,
        logsAvailable: true,
        statsAvailable: true,
        reason: state === "unavailable" ? "Docker context access unavailable; restore source access." : undefined,
        issues: state === "unhealthy" ? ["unhealthy"] : [],
        fingerprint,
      },
    ],
  }
}
function fixture() {
  const task = {
    id: "fix",
    title: "Fix API",
    personaId: "engineer",
    instructions: "Fix API and verify",
    acceptance: ["API works"],
    dependencies: [],
  }
  const mission: Mission = {
    id: "mission",
    goal: "Restore API service",
    chiefId: "chief",
    personas: [
      { id: "chief", name: "Chief", role: "Supervise", agentType: "codex", skills: [] },
      { id: "engineer", name: "Engineer", role: "Fix", agentType: "codex", skills: [] },
    ],
    workspace: {
      issueId: "mission",
      path: "/repo/mission",
      key: "mission",
      branch: "mission",
      status: "idle",
      createdAt: new Date().toISOString(),
    },
    verifyCommand: "true",
    timeoutSec: 5,
    maxRepairs: 1,
    supervision: { maxRounds: 3, rounds: 0, stalledRounds: 0, decisions: [] },
    containerObservationPolicy: policy,
    status: "pending",
    tasks: [],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  let fingerprint = "initial"
  let changes = 0
  const runAgent = vi.fn<ChiefPorts["runAgent"]>(async (_actor, prompt, _current, stage) => {
    if (stage === "plan")
      return JSON.stringify({
        tasks: [task],
        goalBrief: { interpretation: "Restore API service", assumptions: [], successCriteria: ["API works"] },
      })
    if (stage === "work") {
      fingerprint = `change-${++changes}`
      return "Fixed service.ts; tests passed."
    }
    if (stage === "supervise") {
      expect(prompt).toContain("containerObservation")
      return JSON.stringify({
        action: "repair",
        reason: "API still unhealthy",
        instructions: "Fix runtime error within the original goal; reconcile external effects before retry.",
      })
    }
    return JSON.stringify({
      passed: true,
      summary: "Verified actual evidence",
      findings: [],
      ...(stage === "final-review"
        ? {
            criteria: [
              {
                criterion: "API works",
                passed: true,
                evidence: "Verified service code and fresh configured health evidence",
              },
            ],
          }
        : {}),
    })
  })
  const ports: ChiefPorts = {
    runAgent,
    save: vi.fn(async (current) => {
      missionSchema.parse(current)
    }),
    verify: vi.fn(async () => ({ ok: true, output: "Code tests passed" })),
    fingerprint: async () => fingerprint,
    observeContainers: vi.fn(async () => snapshot()),
  }
  return { mission, ports, runAgent }
}

describe("configured service recovery completion", () => {
  it.each(["final-review", "report", "metrics"] as const)(
    "refreshes expired health after long %s and completes only with a healthy new sample",
    async (stage) => {
      const { mission, ports, runAgent } = fixture()
      let clock = Date.now()
      const time = vi.spyOn(Date, "now").mockImplementation(() => clock)
      try {
        const saved: string[] = []
        ports.save = async (current) => {
          missionSchema.parse(current)
          saved.push(current.status)
        }
        const original = runAgent.getMockImplementation()
        runAgent.mockImplementation(async (...args) => {
          if (args[3] === "report") {
            expect(args[2].status).toBe("reviewing")
            expect(saved).not.toContain("completed")
            if (stage === "report") clock += 60_000
            return JSON.stringify(fallbackReport({ ...args[2], status: "completed" }))
          }
          if (args[3] === stage) clock += 60_000
          return (await original?.(...args)) ?? ""
        })
        if (stage === "metrics")
          ports.refreshOrganization = async () => {
            clock += 60_000
            return organizationEvidence()
          }
        await coordinate(mission, ports)
        expect(mission.status).toBe("completed")
        expect(ports.observeContainers).toHaveBeenCalledTimes(3)
        expect(Date.parse(mission.containerObservation?.nextPollAt ?? "")).toBeGreaterThan(clock)
        expect(saved.filter((status) => status === "completed")).toHaveLength(1)
      } finally {
        time.mockRestore()
      }
    },
  )

  it.each(["final-review", "report", "metrics"] as const)(
    "blocks completion and invokes Chief recovery when health fails after long %s",
    async (stage) => {
      const { mission, ports, runAgent } = fixture()
      let clock = Date.now()
      const time = vi.spyOn(Date, "now").mockImplementation(() => clock)
      try {
        const saved: string[] = []
        ports.save = async (current) => {
          missionSchema.parse(current)
          saved.push(current.status)
        }
        let observed = 0
        ports.observeContainers = vi.fn(async () => snapshot(++observed < 3 ? "healthy" : "unhealthy"))
        const original = runAgent.getMockImplementation()
        runAgent.mockImplementation(async (...args) => {
          if (args[3] === "supervise")
            return JSON.stringify({
              action: "stop",
              reason: "Service remains unhealthy; inspect the configured runtime.",
            })
          if (args[3] === stage) clock += 60_000
          if (args[3] === "report") {
            expect(args[2].status).not.toBe("completed")
            return JSON.stringify(fallbackReport(args[2]))
          }
          return (await original?.(...args)) ?? ""
        })
        if (stage === "metrics")
          ports.refreshOrganization = async () => {
            clock += 60_000
            return organizationEvidence()
          }
        await expect(coordinate(mission, ports)).rejects.toThrow("stopped before achieving")
        expect(mission.status).toBe("failed")
        expect(mission.goal).toBe("Restore API service")
        expect(mission.containerObservationVerifiedFingerprint).toBeUndefined()
        expect(runAgent.mock.calls.some((call) => call[3] === "supervise")).toBe(true)
        expect(saved).not.toContain("completed")
        expect(renderReport(mission)).toContain("코드 검증과 별도로")
      } finally {
        time.mockRestore()
      }
    },
  )

  it("pauses source unavailability discovered after a long report without saving completion", async () => {
    const { mission, ports, runAgent } = fixture()
    let clock = Date.now()
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock)
    try {
      let observed = 0
      ports.observeContainers = vi.fn(async () => snapshot(++observed < 3 ? "healthy" : "unavailable"))
      const saved: string[] = []
      ports.save = async (current) => {
        missionSchema.parse(current)
        saved.push(current.status)
      }
      const original = runAgent.getMockImplementation()
      runAgent.mockImplementation(async (...args) => {
        if (args[3] === "supervise") {
          expect(args[1]).toContain("Docker context access unavailable")
          return JSON.stringify({
            action: "wait",
            reason: "Required source access is unavailable; retain checks and wait.",
            retryAfterSec: 60,
          })
        }
        if (args[3] === "report") {
          clock += 60_000
          return JSON.stringify(fallbackReport({ ...args[2], status: "completed" }))
        }
        return (await original?.(...args)) ?? ""
      })
      await coordinate(mission, ports)
      expect(mission).toMatchObject({ status: "waiting", execution: { failureKind: "chief-wait" } })
      expect(saved).not.toContain("completed")
      expect(mission.report?.summary).toContain("미완료")
      expect(mission.containerObservationVerifiedFingerprint).toBeUndefined()
    } finally {
      time.mockRestore()
    }
  })

  it("collects fresh evidence for planning and again after code verification before final review", async () => {
    const { mission, ports, runAgent } = fixture()
    mission.containerObservation = snapshot("healthy", 120_000)
    mission.containerObservationVerifiedFingerprint = mission.containerObservation.fingerprint
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(ports.observeContainers).toHaveBeenCalledTimes(2)
    expect(runAgent.mock.calls.find((call) => call[3] === "plan")?.[1]).toContain("Configured container targets")
    expect(runAgent.mock.calls.find((call) => call[3] === "final-review")?.[1]).toContain('"health":"healthy"')
    expect(mission.containerObservationVerifiedFingerprint).toBe(mission.containerObservation?.fingerprint)
    expect(renderReport(mission)).toContain("Container observation:")
  })

  it.each(["unhealthy", "unavailable"] as const)(
    "routes observed %s service evidence to Chief recovery and verifies the same original goal after repair",
    async (state) => {
      const { mission, ports, runAgent } = fixture()
      let observations = 0
      ports.observeContainers = vi.fn(async () => snapshot(++observations < 3 ? state : "healthy"))
      await coordinate(mission, ports)
      expect(mission.status).toBe("completed")
      expect(mission.goal).toBe("Restore API service")
      expect(mission.supervision?.rounds).toBe(1)
      expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(2)
      expect(ports.verify).toHaveBeenCalledTimes(2)
      expect(mission.containerObservation?.results[0]?.health).toBe("healthy")
    },
  )

  it("lets Chief wait on actual unavailable service evidence despite passing code checks", async () => {
    const { mission, ports, runAgent } = fixture()
    ports.observeContainers = vi.fn(async () => snapshot("unavailable"))
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "supervise"
        ? JSON.stringify({
            action: "wait",
            reason: "Service evidence is unavailable; retain verified code and wait.",
            retryAfterSec: 60,
          })
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission).toMatchObject({
      status: "waiting",
      verification: { ok: true },
      execution: { failureKind: "chief-wait" },
    })
    expect(mission.execution?.nextRunAt).toBeDefined()
    expect(mission.supervision?.decisions.at(-1)?.action).toBe("wait")
    expect(runAgent.mock.calls.some((call) => call[3] === "final-review")).toBe(false)
    expect(mission.containerObservationVerifiedFingerprint).toBeUndefined()
    expect(renderReport(mission)).toContain("코드 검증과 별도로")
    expect(renderReport(mission)).toContain("unavailable")
  })

  it("does not reuse saved healthy evidence on resume when actual service evidence is unhealthy", async () => {
    const { mission, ports, runAgent } = fixture()
    await coordinate(mission, ports)
    const priorWork = runAgent.mock.calls.filter((call) => call[3] === "work").length
    ports.observeContainers = vi.fn(async () => snapshot("unavailable"))
    const original = runAgent.getMockImplementation()
    runAgent.mockImplementation(async (...args) =>
      args[3] === "supervise"
        ? JSON.stringify({
            action: "wait",
            reason: "Fresh service access unavailable; retain prior work and wait.",
            retryAfterSec: 60,
          })
        : ((await original?.(...args)) ?? ""),
    )
    await coordinate(mission, ports)
    expect(mission.status).toBe("waiting")
    expect(ports.observeContainers).toHaveBeenCalledOnce()
    expect(runAgent.mock.calls.filter((call) => call[3] === "work")).toHaveLength(priorWork)
    expect(mission.containerObservationVerifiedFingerprint).toBeUndefined()
  })

  it("rejects stale observer evidence before a new Actor call", async () => {
    const { mission, ports, runAgent } = fixture()
    ports.observeContainers = vi.fn(async () => snapshot("healthy", 120_000))
    await coordinate(mission, ports)
    expect(mission).toMatchObject({ status: "paused", execution: { failureKind: "environment" } })
    expect(mission.error).toContain("stale")
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("keeps a missing required observer protected instead of asking Chief to invent service evidence", async () => {
    const { mission, ports, runAgent } = fixture()
    delete ports.observeContainers
    await coordinate(mission, ports)
    expect(mission).toMatchObject({ status: "paused", execution: { failureKind: "environment" } })
    expect(runAgent).not.toHaveBeenCalled()
    expect(mission.containerObservationVerifiedFingerprint).toBeUndefined()
  })

  it("preserves unknown-effect protection before collecting or launching recovery", async () => {
    const { mission, ports, runAgent } = fixture()
    await coordinate(mission, ports)
    if (mission.tasks[0]) mission.tasks[0].effectState = "unknown"
    if (ports.observeContainers) vi.mocked(ports.observeContainers).mockClear()
    runAgent.mockClear()
    await coordinate(mission, ports)
    expect(mission).toMatchObject({ status: "paused", execution: { failureKind: "unknown-effect" } })
    expect(ports.observeContainers).not.toHaveBeenCalled()
    expect(runAgent).not.toHaveBeenCalled()
  })

  it("keeps disabled policy backward compatible without observation", async () => {
    const { mission, ports } = fixture()
    mission.containerObservationPolicy = { ...policy, enabled: false }
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(ports.observeContainers).not.toHaveBeenCalled()
  })

  it("fails closed on foreign/duplicate/missing targets in stored mission evidence and pins policy", () => {
    const mission = reportMission()
    mission.containerObservationPolicy = policy
    mission.containerObservation = snapshot()
    expect(missionSchema.safeParse(mission).success).toBe(true)
    const first = mission.containerObservation.results[0]
    if (first) mission.containerObservation.results.push({ ...first, targetId: "foreign" })
    expect(missionSchema.safeParse(mission).success).toBe(false)
    mission.containerObservation = snapshot()
    const contract = createMissionContract(mission)
    mission.containerObservationPolicy = { ...policy, enabled: false }
    expect(() => contract.assert()).toThrow("immutable operator contract")
    expect(mission.containerObservationPolicy.enabled).toBe(true)
  })
})
