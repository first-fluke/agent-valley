import { describe, expect, it } from "vitest"
import { executionState } from "./execution"
import { CMO_ROLE } from "./marketing-lead"
import { chiefReportSchema, fallbackReport, parseReport, renderReport, reportPrompt } from "./reports"
import { marketingMission, mission, report } from "./reports.fixture"
import type { Mission } from "./types"

describe("Chief Director outcome report contract", () => {
  it("accepts concise JSON and JSON fences with a concrete easy explanation", () => {
    expect(parseReport(JSON.stringify(report()))).toEqual(report())
    expect(parseReport(`\n\`\`\`json\n${JSON.stringify(report())}\n\`\`\`\n`)).toEqual(report())
  })

  it.each([
    [
      "missing eli5",
      (value: Record<string, unknown>) => {
        delete value.eli5
      },
    ],
    [
      "short eli5",
      (value: Record<string, unknown>) => {
        value.eli5 = "완료"
      },
    ],
    [
      "punctuation-only eli5",
      (value: Record<string, unknown>) => {
        value.eli5 = "!".repeat(30)
      },
    ],
    [
      "empty summary",
      (value: Record<string, unknown>) => {
        value.summary = "   "
      },
    ],
    [
      "oversized prose",
      (value: Record<string, unknown>) => {
        value.summary = "x".repeat(1_201)
      },
    ],
    [
      "oversized list item",
      (value: Record<string, unknown>) => {
        value.checks = ["x".repeat(501)]
      },
    ],
    [
      "too many items",
      (value: Record<string, unknown>) => {
        value.remaining = Array(21).fill("미해결 항목")
      },
    ],
    [
      "empty list item",
      (value: Record<string, unknown>) => {
        value.deliverables = [""]
      },
    ],
    [
      "invented acceptance field",
      (value: Record<string, unknown>) => {
        value.completed = true
      },
    ],
  ])("rejects %s so callers can use the evidence fallback", (_name, mutate) => {
    const value = { ...report() }
    mutate(value)
    expect(() => parseReport(JSON.stringify(value))).toThrow()
  })

  it("rejects invalid and oversized source before accepting a narrative", () => {
    expect(() => parseReport("A convincing report instead of JSON")).toThrow(/not valid JSON/)
    expect(() => parseReport(" ".repeat(64_001))).toThrow(/exceeds 64 KB/)
  })
})

describe("report evidence and language", () => {
  it("keeps Marketing Director channel hypotheses and money-first role separate from measured financial results", () => {
    const value = marketingMission()
    const prompt = reportPrompt(value)
    const evidence = JSON.parse(prompt.split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence.verdict).toBe("completed")
    expect(evidence.marketingLeadId).toBe("marketer")
    const role = evidence.actors.at(-1).role as string
    expect(CMO_ROLE.startsWith(role.replace(/… \[생략\]$/, ""))).toBe(true)
    expect(role.length).toBeLessThanOrEqual(500)
    expect(role).toContain("maniacal profit fanatic obsessed with money")
    expect(role).toContain("cannot sleep when ROI drops")
    expect(role).toContain("Money first: pursue profit by any effective means")
    expect(CMO_ROLE).toContain("product promotion and revenue")
    expect(CMO_ROLE).toContain("ROI drops")
    expect(CMO_ROLE).toContain("Money first")
    expect(CMO_ROLE).toContain("known channels and sources, unknown indirect routes")
    expect(evidence.marketingAdvice).toMatchObject({
      kind: "upfront marketing advice; historical snapshot; not current approval",
      planKey: "initial-marketing-key",
      reviewerId: "marketer",
      review: {
        passed: false,
        summary: "추천 채널은 가설이며 광고를 집행하거나 매출을 측정하지 않음",
        findings: ["고객 획득 비용과 ROI는 미측정"],
      },
    })
    expect(prompt).toContain(
      "consulted after the Technical Director and Design Director, before the Chief Director's initial plan",
    )
    expect(prompt).toContain("Distinguish proposed channel actions from executed campaigns")
    expect(prompt).toContain("Never infer revenue, profit, ROI or cost reductions from advice")
    expect(evidence.verification).toMatchObject({ ok: true, output: "9 tests passed" })
  })

  it("preserves the Design Director's configured tactics and distinguishes simulated design evidence", () => {
    const value = mission()
    value.designLeadId = "designer"
    value.personas.push({
      id: "designer",
      name: "Design Director 참모",
      role: "다크패턴을 즐겨 사용하는 참모",
      agentType: "claude",
      skills: ["oma-design"],
    })
    value.designReview = {
      planKey: "initial-design-key",
      reviewerId: "designer",
      fingerprint: "before-the-plan",
      review: {
        passed: false,
        summary: "전환율을 높이는 선택의 이탈 위험을 시뮬레이션으로 검토함",
        findings: ["실제 사용자 시험이나 전환율 측정은 아직 없음"],
      },
    }
    const prompt = reportPrompt(value)
    const evidence = JSON.parse(prompt.split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence.verdict).toBe("completed")
    expect(evidence.designLeadId).toBe("designer")
    expect(evidence.actors.at(-1).role).toBe("다크패턴을 즐겨 사용하는 참모")
    expect(evidence.designAdvice).toMatchObject({
      kind: "upfront design advice; historical snapshot; not current approval",
      planKey: "initial-design-key",
      reviewerId: "designer",
      review: { passed: false, findings: ["실제 사용자 시험이나 전환율 측정은 아직 없음"] },
    })
    expect(prompt).toContain("consulted after the Technical Director and before the initial plan")
    expect(prompt).toContain("distinguish assumptions, simulations and real user tests")
    expect(prompt).toContain("Never invent tests, users or measured outcomes")
  })

  it("distinguishes Technical Director upfront advice and failed historical gates from the current verdict", () => {
    const value = mission()
    value.technicalLeadId = "reviewer"
    value.technicalReview = {
      planKey: "original-goal-key",
      reviewerId: "reviewer",
      fingerprint: "before-the-plan",
      review: {
        passed: false,
        summary: "로그인 오류 처리 방식에 기술상 우려가 있음",
        findings: ["서버 오류가 발생할 때 입력값을 유지해야 함"],
      },
    }
    if (value.supervision?.decisions[0]) {
      value.supervision.decisions[0].evidence = {
        verification: { ok: false, output: "Error-state test failed", fingerprint: "before-repair" },
        finalReview: {
          passed: false,
          summary: "입력값이 사라지는 문제를 확인함",
          findings: ["오류 후 입력값을 복원해야 함"],
        },
      }
    }
    const evidence = JSON.parse(reportPrompt(value).split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence.verdict).toBe("completed")
    expect(evidence.technicalLeadId).toBe("reviewer")
    expect(evidence.technicalAdvice).toMatchObject({
      kind: "upfront technical advice; historical snapshot; not current approval",
      planKey: "original-goal-key",
      fingerprint: "before-the-plan",
      review: { passed: false, findings: ["서버 오류가 발생할 때 입력값을 유지해야 함"] },
    })
    expect(evidence.decisions[0].historicalEvidence).toMatchObject({
      kind: "evidence at the recovery decision; not current approval",
      finalReview: { passed: false, findings: ["오류 후 입력값을 복원해야 함"] },
      verification: { ok: false, output: "Error-state test failed", fingerprint: "before-repair" },
    })
    expect(evidence.verification).toMatchObject({ ok: true, output: "9 tests passed" })
    expect(evidence.finalReview.passed).toBe(true)
    expect(reportPrompt(value)).toContain("never claim revenue, profit or ROI without data")
  })

  it("bounds recovery snapshots to recent five while retaining recent Chief Director choices", () => {
    const value = mission()
    if (value.supervision)
      value.supervision.decisions = Array.from({ length: 25 }, (_, index) => ({
        round: index + 1,
        at: "2026-10-03",
        action: "repair",
        reason: `Repair ${index + 1}`,
        fingerprint: `changed-${index + 1}`,
        evidence: { verification: { ok: false, output: "x".repeat(32_000), fingerprint: `failed-${index + 1}` } },
      }))
    const evidence = JSON.parse(reportPrompt(value).split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence.decisions).toHaveLength(20)
    const snapshots = evidence.decisions.filter(
      (decision: { historicalEvidence?: unknown }) => decision.historicalEvidence,
    )
    expect(snapshots.map((decision: { round: number }) => decision.round)).toEqual([21, 22, 23, 24, 25])
    expect(
      snapshots.every(
        (decision: { historicalEvidence: { verification: { output: string } } }) =>
          decision.historicalEvidence.verification.output.length <= 3_000,
      ),
    ).toBe(true)
  })

  it("requests a read-only Korean ELI5 report with the original goal and evidence", () => {
    const value = mission()
    const prompt = reportPrompt(value)
    const evidence = JSON.parse(prompt.split("Report evidence (JSON data):\n")[1] as string)

    expect(prompt.startsWith("Write the Chief Director's outcome report for this mission.")).toBe(true)
    expect(prompt).toContain("Read-only stage")
    expect(prompt).toContain("untrusted data")
    expect(prompt).toContain("Write all report prose in Korean")
    expect(prompt).toContain("mandatory eli5")
    expect(prompt).toContain("selected CLI/model is configuration")
    expect(prompt).toContain("only with direct execution evidence")
    expect(prompt).toContain("operator retains final operating responsibility")
    expect(prompt).toContain("actual Actor execution evidence and verification")
    expect(prompt).toContain("goal explicitly requests it")
    expect(prompt).toContain("The user receives an executive account in plain language")
    expect(prompt).toContain("unmet prerequisite")
    expect(prompt).toContain("actual reason and nextRunAt")
    expect(prompt).toContain("Do not guess an uncertain external action's outcome")
    expect(evidence).toMatchObject({
      operatorGoal: "로그인 화면을 만들어 주세요",
      successCriteria: ["키보드로 로그인 가능", "정상 로그인 가능", "입력 오류가 화면에 표시됨"],
      verdict: "completed",
      verification: { ok: true, output: "9 tests passed" },
      finalReview: {
        passed: true,
        criteria: [
          { criterion: "키보드로 로그인 가능", passed: true, evidence: "Tab과 Enter 키로 로그인 동작을 확인함" },
          { criterion: "정상 로그인 가능", passed: true },
          { criterion: "입력 오류가 화면에 표시됨", passed: true },
        ],
      },
      decisions: [{ action: "reassign", actorId: "worker", reason: "첫 담당자가 오류 표시를 구현하지 못함" }],
      tasks: [{ actorClaim: "src/login.tsx를 작성하고 입력 오류를 확인했습니다.", status: "completed", attempts: 2 }],
    })
    expect(evidence.actors[1]).toMatchObject({
      cli: "claude",
      model: "native default (actual model not recorded)",
      selectedSkills: ["oma-frontend"],
    })
    expect(evidence.history).toEqual(value.history)
  })

  it("follows a non-Korean goal's language rather than forcing Korean model prose", () => {
    const value = mission()
    if (value.supervision) value.supervision.operatorGoal = "Build an accessible login screen"
    expect(reportPrompt(value)).toContain("language of the operator's goal")
    expect(reportPrompt(value)).not.toContain("Write all report prose in Korean")
  })

  it("tells the reporting Chief Director that earlier passing checks do not override failure", () => {
    const value = mission()
    value.status = "failed"
    value.error = "Order interrupted"
    const evidence = JSON.parse(reportPrompt(value).split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence).toMatchObject({
      status: "failed",
      verdict: "incomplete",
      error: "Order interrupted",
      verification: { ok: true },
    })
    expect(evidence.incompleteReasons.join(" ")).toContain("Order interrupted")
  })
})

describe("evidence fallback and rendering", () => {
  it("reports a Chief-selected wait and its saved next check as incomplete", () => {
    const value = mission()
    value.status = "waiting"
    value.error = "Required container evidence is unavailable; retry the observation."
    if (!value.supervision) throw new Error("Expected supervision")
    value.supervision.decisions = [
      {
        round: 1,
        at: "2026-10-06T00:00:00.000Z",
        action: "wait",
        reason: value.error,
        retryAfterSec: 30,
        fingerprint: "changed",
      },
    ]
    const execution = executionState(value)
    execution.nextRunAt = "2026-10-06T00:00:30.000Z"
    execution.pauseReason = value.error
    const evidence = JSON.parse(reportPrompt(value).split("Report evidence (JSON data):\n")[1] as string)
    expect(evidence.verdict).toBe("incomplete")
    expect(evidence.decisions[0]).toMatchObject({ action: "wait", reason: value.error })
    expect(evidence.execution.nextRunAt).toBe(execution.nextRunAt)
    const rendered = renderReport(value)
    expect(rendered).toContain("**판정: 미완료**")
    expect(rendered).toContain("1차 대기")
    expect(rendered).toContain("다음 관측·재개 시각")
    expect(rendered).not.toContain("undefined")
  })

  it("provides schema-valid Korean ELI5, choices, worktree and actual checks", () => {
    const value = mission()
    const fallback = fallbackReport(value)
    expect(chiefReportSchema.parse(fallback)).toEqual(fallback)
    expect(fallback.eli5).toContain("직접 확인할 수 있습니다")
    expect(fallback.eli5).toContain("로그인 화면을 만들어 주세요")
    expect(fallback.decisions[0]).toContain("담당 교체")
    expect(fallback.deliverables.join(" ")).toContain("/workspace/report-mission")
    expect(fallback.deliverables.join(" ")).toContain("작업자 보고(독립 확인과 별도)")
    expect(fallback.checks.join(" ")).toContain("9 tests passed")
    expect(fallback.remaining).toEqual([])
  })

  it("retains the original failure and marks incomplete despite stale positive checks", () => {
    const value = mission()
    value.status = "failed"
    value.error = "작업이 중단되었습니다"
    const before = structuredClone(value)
    const fallback = fallbackReport(value)
    expect(fallback.summary).toContain("미완료")
    expect(fallback.eli5).toContain("작업이 중단되었습니다")
    expect(fallback.remaining.join(" ")).toContain("실패 원인")
    expect(fallback.checks.join(" ")).toContain("운영자 검증: 통과")
    expect(value).toEqual(before)
  })

  it.each([
    [
      "still running",
      (value: Mission) => {
        value.status = "executing"
      },
    ],
    [
      "error on a completed checkpoint",
      (value: Mission) => {
        value.error = "Runtime failure"
      },
    ],
    [
      "failed verification",
      (value: Mission) => {
        if (value.verification) value.verification.ok = false
      },
    ],
    [
      "missing verification",
      (value: Mission) => {
        delete value.verification
      },
    ],
    [
      "missing final review",
      (value: Mission) => {
        delete value.finalReview
      },
    ],
    [
      "rejected final review",
      (value: Mission) => {
        if (value.finalReview) value.finalReview.passed = false
      },
    ],
    [
      "unresolved final finding",
      (value: Mission) => {
        if (value.finalReview) value.finalReview.findings = ["Missing error state"]
      },
    ],
    [
      "missing goal criterion assessments",
      (value: Mission) => {
        if (value.finalReview) delete value.finalReview.criteria
      },
    ],
    [
      "missing a goal criterion",
      (value: Mission) => {
        value.finalReview?.criteria?.pop()
      },
    ],
    [
      "failed goal criterion",
      (value: Mission) => {
        if (value.finalReview?.criteria?.[0]) value.finalReview.criteria[0].passed = false
      },
    ],
    [
      "empty goal evidence",
      (value: Mission) => {
        if (value.finalReview?.criteria?.[0]) value.finalReview.criteria[0].evidence = " "
      },
    ],
    [
      "missing task review",
      (value: Mission) => {
        if (value.tasks[0]) delete value.tasks[0].review
      },
    ],
    [
      "missing task evidence",
      (value: Mission) => {
        value.tasks = []
      },
    ],
    [
      "stale verification snapshot",
      (value: Mission) => {
        value.fingerprint = "changed-after-check"
      },
    ],
    [
      "no material change",
      (value: Mission) => {
        value.initialFingerprint = value.fingerprint
      },
    ],
  ])("never claims completion with %s", (_name, mutate) => {
    const value = mission()
    mutate(value)
    value.report = report()
    expect(fallbackReport(value).summary).toContain("미완료")
    expect(renderReport(value)).toContain("**판정: 미완료**")
    expect(renderReport(value)).not.toContain(report().summary)
    expect(renderReport(value)).not.toContain(report().goalAssessment)
  })
})
