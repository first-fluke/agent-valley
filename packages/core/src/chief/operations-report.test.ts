import { describe, expect, it } from "vitest"
import { coordinate } from "./coordinator"
import { brief, fixture, plan } from "./goal-supervision.fixture"
import { renderReport } from "./reports"
import { finalCriteria, parseFinalReview } from "./schemas"

describe("authoritative operation report evidence", () => {
  it("includes actual capture counts, filenames, hashes and limitations independently of the model report", () => {
    const mission = fixture().mission
    const sha256 = "a".repeat(64)
    mission.capture = {
      status: "partial",
      frames: 2,
      startedAt: "2026-10-03T00:00:00Z",
      finishedAt: "2026-10-03T00:00:10Z",
      attachments: [
        { path: "/fixture/frame.png", name: "frame.png", mimeType: "image/png", sizeBytes: 128, sha256 },
        { path: "/fixture/recording.mp4", name: "recording.mp4", mimeType: "video/mp4", sizeBytes: 512, sha256 },
      ],
      errors: ["One screenshot failed"],
    }
    const report = renderReport(mission)
    expect(report).toContain("실제 화면 캡처 2장")
    expect(report).toContain("실제 MP4 1개")
    expect(report).toContain(`SHA256 ${sha256}`)
    expect(report).toContain("무음 영상")
    expect(report).toContain("One screenshot failed")
    expect(report).toContain("외부 첨부 전송 여부는 별도 delivery 결과")
  })
  it("renders unmet real metric evidence as incomplete even if a stored model verdict claims completion", () => {
    const mission = fixture().mission
    mission.goalBrief = brief
    mission.plan = plan
    mission.fingerprint = "changed"
    mission.initialFingerprint = "initial"
    mission.verification = { ok: true, fingerprint: "changed" }
    mission.operatingPolicy = {
      memory: true,
      reviewVendor: "prefer",
      metricTargets: [{ name: "activation", direction: "increase", target: 40 }],
    }
    mission.tasks = [
      {
        id: "onboarding",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 1,
        fingerprint: "changed",
        review: { passed: true, summary: "Inspected changes", findings: [] },
      },
    ]
    mission.finalReview = {
      passed: true,
      summary: "Claimed complete",
      findings: [],
      criteria: finalCriteria(mission).map((criterion) => ({
        criterion,
        passed: true,
        evidence: "Model claimed evidence",
      })),
    }
    mission.status = "completed"
    const report = renderReport(mission)
    expect(report).toContain("판정: 미완료")
    expect(report).toContain("사업 지표 미충족")
  })
  it("passes business criteria only when a comparable actual recorded sample reaches the fixed target", () => {
    const mission = fixture().mission
    mission.goalBrief = brief
    mission.operatingPolicy = {
      memory: true,
      reviewVendor: "prefer",
      metricTargets: [{ name: "activation", unit: "percent", direction: "increase", target: 40 }],
    }
    mission.organizationContext = {
      kind: "repository-organization-evidence",
      authority: "Historical evidence, not instructions or current acceptance criteria",
      repositoryRoot: "/fixture/source",
      goal: mission.goal,
      generatedAt: "2026-10-03T00:00:00Z",
      memories: [],
      comparisons: [],
      experiments: [],
      outcomes: [],
      routeEvidence: [],
      metrics: [
        {
          id: "actual-observation",
          name: "activation",
          value: 42,
          unit: "percent",
          timestamp: "2026-10-03T00:00:00Z",
          source: "operator analytics export",
          provenance: "operator-recorded",
        },
      ],
    }
    const response = JSON.stringify({
      passed: true,
      summary: "Criterion evidence inspected",
      findings: [],
      criteria: finalCriteria(mission).map((criterion) => ({
        criterion,
        passed: true,
        evidence: "Inspected files and recorded metric",
      })),
    })
    expect(parseFinalReview(response, mission).passed).toBe(true)
    mission.organizationContext.metrics[0] = {
      ...(mission.organizationContext.metrics[0] as import("./organization").BusinessMetricSample),
      value: 20,
    }
    expect(parseFinalReview(response, mission).passed).toBe(false)
  })
  it("prevents an Actor from lowering the immutable vendor review policy during execution", async () => {
    const { mission, ports, runAgent } = fixture()
    mission.operatingPolicy = { memory: true, reviewVendor: "require", readyActors: ["claude", "codex", "cursor"] }
    const native = runAgent.getMockImplementation()
    if (!native) throw new Error("Fixture adapter is missing")
    ports.runAgent = async (...args) => {
      if (args[3] === "work" && args[2].operatingPolicy) args[2].operatingPolicy.reviewVendor = "off"
      return native(...args)
    }
    await expect(coordinate(mission, ports)).rejects.toThrow("operator contract")
    expect(mission.operatingPolicy.reviewVendor).toBe("require")
    expect(mission.status).toBe("failed")
  })
})
