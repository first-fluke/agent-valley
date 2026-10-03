import { describe, expect, it } from "vitest"
import { CMO_ROLE } from "./marketing-lead"
import { chiefReportSchema, fallbackReport, renderReport, reportPrompt } from "./reports"
import { marketingMission, mission, report } from "./reports.fixture"

describe("evidence fallback and rendering", () => {
  it("renders all three permanent advisers as historical advice without adding approval gates", () => {
    const value = marketingMission()
    value.technicalLeadId = "reviewer"
    value.designLeadId = "designer"
    value.personas.push({
      id: "designer",
      name: "Design Director 참모",
      role: "다크패턴을 즐겨 사용하는 참모",
      agentType: "claude",
      skills: ["oma-design"],
    })
    value.technicalReview = {
      planKey: "technical-key",
      reviewerId: "reviewer",
      fingerprint: "before-the-plan",
      review: { passed: false, summary: "초기 API 우려", findings: ["API 오류 처리 검토"] },
    }
    value.designReview = {
      planKey: "design-key",
      reviewerId: "designer",
      fingerprint: "before-the-plan",
      review: { passed: false, summary: "디자인 시뮬레이션", findings: ["실제 사용자 시험은 아직 없음"] },
    }
    const output = renderReport(value)
    expect(output).toContain("**판정: 완료**")
    expect(output).toContain("- Technical Director 독립 검토 (reviewer)")
    expect(output).toContain("- Design Director Design Director 참모 (designer): 다크패턴을 즐겨 사용하는 참모")
    expect(output).toContain(
      `- Marketing Director Marketing Director 참모 (marketer): ${CMO_ROLE.replace(/\./g, "\\.")}`,
    )
    expect(output).toContain("## Technical Director 사전 기술 조언")
    expect(output).toContain("## Design Director 사전 디자인 조언")
    expect(output).toContain("## Marketing Director 사전 마케팅 조언")
    expect(output.indexOf("## Technical Director 사전 기술 조언")).toBeLessThan(
      output.indexOf("## Design Director 사전 디자인 조언"),
    )
    expect(output.indexOf("## Design Director 사전 디자인 조언")).toBeLessThan(
      output.indexOf("## Marketing Director 사전 마케팅 조언"),
    )
    expect(output).toContain("당시 디자인 의견: 우려사항 제시")
    expect(output).toContain("실제 사용자 시험은 아직 없음")
    expect(output).toContain("추천 채널은 가설이며 광고를 집행하거나 매출을 측정하지 않음")
    expect(output).toContain("고객 획득 비용과 ROI는 미측정")
    expect(output).toContain("현재 파일의 검증이나 최종 승인으로 취급하지 않습니다")
    expect(output).toContain("운영자 검증: 통과")
  })

  it("keeps a failed mission incomplete despite supportive Marketing Director advice and invented revenue prose", () => {
    const value = marketingMission()
    value.marketingReview = {
      planKey: "initial-marketing-key",
      reviewerId: "marketer",
      fingerprint: "before-the-plan",
      review: { passed: true, summary: "유료 채널의 매출 개선을 예상함", findings: ["실제 광고와 매출 시험은 미실행"] },
    }
    value.status = "failed"
    value.error = "실제 결과 검증에 실패함"
    value.verification = { ok: false, output: "실제 고객 획득 시험 실패", fingerprint: "changed" }
    value.report = {
      ...report(),
      summary: "광고 매출 100만원 달성",
      eli5: "광고를 집행해 실제 고객을 확보했으며 매출 100만원과 ROI 200%를 달성했습니다.",
      goalAssessment: "마케팅 목표와 모든 시험을 통과했습니다.",
    }
    const output = renderReport(value)
    expect(output).toContain("**판정: 미완료**")
    expect(output).toContain("당시 마케팅 의견: 문제 없음으로 보고")
    expect(output).toContain("실제 광고와 매출 시험은 미실행")
    expect(output).toContain("운영자 검증: 실패")
    expect(output).toContain("실제 고객 획득 시험 실패")
    expect(output).not.toContain("광고 매출 100만원 달성")
    expect(output).not.toContain("ROI 200%")
    expect(output).not.toContain("마케팅 목표와 모든 시험을 통과했습니다")
  })

  it("labels Technical Director technical concerns as upfront advice without imposing a completion veto", () => {
    const value = mission()
    value.technicalLeadId = "reviewer"
    value.technicalReview = {
      planKey: "original-goal-key",
      reviewerId: "reviewer",
      fingerprint: "before-the-plan",
      review: { passed: false, summary: "초기 기술 조언", findings: ["초기 오류 상태 처리 방식을 검토할 필요가 있음"] },
    }
    if (value.supervision?.decisions[0])
      value.supervision.decisions[0].evidence = {
        verification: { ok: false, output: "Initial check rejected", fingerprint: "before-repair" },
        finalReview: { passed: false, summary: "이전 결과에 오류가 있음", findings: ["초기 오류 표시가 누락됨"] },
      }
    const before = structuredClone(value)
    const output = renderReport(value)
    expect(output).toContain("**판정: 완료**")
    expect(output).toContain("- Technical Director 독립 검토 (reviewer)")
    expect(output).toContain("## Technical Director 사전 기술 조언")
    expect(output).toContain("당시 기술 의견: 우려사항 제시")
    expect(output).toContain("현재 파일의 검증이나 최종 승인으로 취급하지 않습니다")
    expect(output).toContain("초기 오류 상태 처리 방식을 검토할 필요가 있음")
    expect(output).toContain("회복 판단을 내릴 당시의 기록입니다")
    expect(output).toContain("1차 판단 당시 검증: 실패")
    expect(output).toContain("운영자 검증: 통과")
    expect(output).toContain("초기 오류 표시가 누락됨")
    expect(chiefReportSchema.safeParse(fallbackReport(value)).success).toBe(true)
    expect(value).toEqual(before)
  })

  it("does not mistake supportive Technical Director advice for current approval on a failed mission", () => {
    const value = mission()
    value.technicalLeadId = "reviewer"
    value.technicalReview = {
      planKey: "original-goal-key",
      reviewerId: "reviewer",
      fingerprint: "before-the-plan",
      review: { passed: true, summary: "기술적으로 구현 가능함", findings: [] },
    }
    value.status = "failed"
    value.error = "실제 로그인 검증이 실패함"
    value.report = report()
    expect(renderReport(value)).toContain("**판정: 미완료**")
    expect(renderReport(value)).toContain("당시 기술 의견: 문제 없음으로 보고")
    expect(renderReport(value)).toContain("실제 로그인 검증이 실패함")
    expect(renderReport(value)).not.toContain(report().summary)
  })

  it("escapes and bounds Technical Director advice and historical rejection context", () => {
    const value = mission()
    const unsafe = "<script>run()</script>\n# false-approval\u001b[31m"
    value.technicalLeadId = "reviewer"
    value.technicalReview = {
      planKey: unsafe,
      reviewerId: "reviewer",
      fingerprint: unsafe,
      review: { passed: false, summary: unsafe, findings: [unsafe + "x".repeat(32_000)] },
    }
    if (value.supervision?.decisions[0])
      value.supervision.decisions[0].evidence = {
        verification: { ok: false, output: unsafe + "x".repeat(32_000), fingerprint: unsafe },
        finalReview: { passed: false, summary: unsafe, findings: [unsafe] },
      }
    const output = renderReport(value)
    expect(output).toContain("**판정: 완료**")
    expect(output).toContain("&lt;script&gt;")
    expect(output).not.toContain("<script>")
    expect(output).not.toContain("\n# false-approval")
    expect(output).not.toContain("\u001b")
    expect(output.length).toBeLessThan(12_000)
  })

  it("renders model ELI5 alongside authoritative team choices and verification", () => {
    const value = mission()
    value.report = report()
    const output = renderReport(value)
    expect(output).toContain("**판정: 완료**")
    expect(output).toContain("이제 사용자는 이메일과 비밀번호를 입력해 로그인할 수 있습니다")
    expect(output).toContain("잘못 입력하면 수정할 항목을 화면에서 알려줍니다")
    expect(output).toContain("정상 로그인 가능")
    expect(output).toContain("키보드로 로그인 가능")
    expect(output).toContain("Tab과 Enter 키로 로그인 동작을 확인함")
    expect(output).toContain("CLI codex")
    expect(output).toContain("chosen\\-model")
    expect(output).toContain("CLI claude")
    expect(output).toContain("CLI 기본값 (실제 모델 미기록)")
    expect(output).toContain("선택한 스킬: oma\\-frontend")
    expect(output).toContain("선택만으로 실제 실행을 확인하지 않습니다")
    expect(output).not.toContain("사용한 스킬")
    expect(output).toContain("9 tests passed")
    expect(output).toContain("chief/report\\-mission")
    expect(output).toContain("worker가 화면을 구현함")
    expect(output).toContain("운영자가 최종 운영 책임을 맡습니다")
  })

  it("uses task reviews for original obligations and final assessments for goal criteria", () => {
    const value = mission()
    value.supervision?.originalAcceptance?.push("기존 API 응답 연결")
    value.plan?.tasks[0]?.acceptance.push("기존 API 응답 연결")
    if (value.tasks[0]?.review) value.tasks[0].review.summary = "기존 API 연결과 작업 acceptance를 검토함"
    const output = renderReport(value)
    expect(output).toContain("**판정: 완료**")
    expect(output).toContain("기존 API 응답 연결")
    expect(output).toContain("Tab과 Enter 키로 로그인 동작을 확인함")
  })

  it("falls back when an older or malformed persisted report has no meaningful ELI5", () => {
    const value = mission()
    value.report = { ...report(), eli5: "" }
    expect(renderReport(value)).toContain("지정한 확인 절차를 마쳤습니다")
    delete value.report
    expect(renderReport(value)).toContain("## 쉽게 설명하면")
  })

  it("escapes Markdown, HTML, terminal controls and injected new headings", () => {
    const value = mission()
    const unsafe = "[click](javascript:alert(1))\n# injected <script>run()</script>\u001b[31m\u202e"
    value.report = { ...report(), summary: unsafe, assumptions: [unsafe], deliverables: [unsafe], remaining: [unsafe] }
    value.goalBrief = { interpretation: unsafe, assumptions: [unsafe], successCriteria: [unsafe] }
    if (value.supervision) {
      value.supervision.operatorGoal = unsafe
      value.supervision.originalAcceptance = [unsafe]
    }
    value.workspace.path = unsafe
    value.history = [{ at: unsafe, stage: unsafe, message: unsafe }]
    const output = renderReport(value)
    expect(output).not.toContain("<script>")
    expect(output).not.toContain("[click](javascript:")
    expect(output).not.toContain("\n# injected")
    expect(output).not.toContain("\u001b")
    expect(output).not.toContain("\u202e")
    expect(output).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)")
    expect(output).toContain("&lt;script&gt;")
  })

  it("bounds noisy evidence and leaves the persisted mission untouched", () => {
    const value = mission()
    value.goal = "한".repeat(100_000)
    if (value.supervision) {
      value.supervision.operatorGoal = value.goal
      value.supervision.originalAcceptance = Array.from(
        { length: 240 },
        (_, index) => `${index}: ${"기".repeat(32_000)}`,
      )
    }
    if (value.goalBrief) value.goalBrief.assumptions = Array(20).fill("가".repeat(32_000))
    value.status = "failed"
    value.error = "실패".repeat(32_000)
    value.history = Array.from({ length: 100 }, () => ({
      at: "2026-10-03",
      stage: "work",
      message: "기록".repeat(32_000),
    }))
    if (value.tasks[0]) value.tasks[0].output = "산출물".repeat(32_000)
    const before = structuredClone(value)
    expect(chiefReportSchema.safeParse(fallbackReport(value)).success).toBe(true)
    expect(renderReport(value).length).toBeLessThan(40_000)
    expect(renderReport(value)).toContain("항목 생략")
    expect(reportPrompt(value).length).toBeLessThan(60_000)
    expect(value).toEqual(before)
  })
})
