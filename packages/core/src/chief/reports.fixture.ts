import { CMO_ROLE } from "./marketing-lead"
import type { ChiefReport } from "./reports"
import type { Mission } from "./types"

export function report(): ChiefReport {
  return {
    summary: "사용자가 확인할 수 있는 로그인 화면을 만들었습니다.",
    eli5: "이제 사용자는 이메일과 비밀번호를 입력해 로그인할 수 있습니다. 잘못 입력하면 수정할 항목을 화면에서 알려줍니다.",
    goalAssessment: "정상 로그인과 입력 오류 표시를 실제 파일 및 검증 결과로 확인했습니다.",
    assumptions: ["기존 로그인 API를 사용합니다."],
    decisions: ["Chief Director가 구현과 독립 리뷰를 서로 다른 담당자에게 배정했습니다."],
    deliverables: ["src/login.tsx"],
    checks: ["운영자 검증 bun test: 9개 검사 통과"],
    remaining: ["외부 배포 결과는 확인하지 않았습니다."],
  }
}

export function mission(): Mission {
  return {
    id: "report-mission",
    goal: "재계획 후 로그인 작업",
    chiefId: "chief",
    workspace: {
      issueId: "report-mission",
      key: "report-mission",
      path: "/workspace/report-mission",
      branch: "chief/report-mission",
      status: "idle",
      createdAt: "2026-10-03",
    },
    personas: [
      {
        id: "chief",
        name: "Chief Director",
        role: "목표 해석과 최종 검토",
        agentType: "codex",
        model: "chosen-model",
        skills: ["oma-architecture"],
      },
      { id: "worker", name: "화면 담당", role: "로그인 화면 구현", agentType: "claude", skills: ["oma-frontend"] },
      { id: "reviewer", name: "독립 검토", role: "입력 오류와 정상 로그인 확인", agentType: "cursor", skills: [] },
    ],
    goalBrief: {
      interpretation: "기존 API를 연결한 로그인 화면을 구현합니다.",
      assumptions: ["기존 로그인 API를 사용합니다."],
      successCriteria: ["키보드로 로그인 가능", "정상 로그인 가능", "입력 오류가 화면에 표시됨"],
    },
    supervision: {
      maxRounds: 3,
      rounds: 1,
      stalledRounds: 0,
      originalAcceptance: ["정상 로그인 가능", "입력 오류가 화면에 표시됨"],
      operatorGoal: "로그인 화면을 만들어 주세요",
      operatorVerifyCommand: "bun test",
      decisions: [
        {
          round: 1,
          at: "2026-10-03",
          action: "reassign",
          reason: "첫 담당자가 오류 표시를 구현하지 못함",
          personaId: "worker",
          taskId: "login",
          fingerprint: "before",
        },
      ],
    },
    verifyCommand: "bun test",
    timeoutSec: 300,
    maxRepairs: 1,
    status: "completed",
    createdAt: "2026-10-03",
    updatedAt: "2026-10-03",
    plan: {
      tasks: [
        {
          id: "login",
          title: "로그인 화면",
          personaId: "worker",
          instructions: "로그인 화면 구현",
          acceptance: ["정상 로그인 가능", "입력 오류가 화면에 표시됨"],
          dependencies: [],
        },
      ],
    },
    tasks: [
      {
        id: "login",
        reviewerId: "reviewer",
        status: "completed",
        attempts: 2,
        output: "src/login.tsx를 작성하고 입력 오류를 확인했습니다.",
        review: { passed: true, summary: "실제 화면과 입력 오류를 검토함", findings: [] },
        fingerprint: "changed",
      },
    ],
    verification: { ok: true, output: "9 tests passed", fingerprint: "changed" },
    finalReview: {
      passed: true,
      summary: "원래 성공 기준을 확인함",
      findings: [],
      criteria: [
        { criterion: "키보드로 로그인 가능", passed: true, evidence: "Tab과 Enter 키로 로그인 동작을 확인함" },
        { criterion: "정상 로그인 가능", passed: true, evidence: "올바른 계정으로 로그인됨" },
        { criterion: "입력 오류가 화면에 표시됨", passed: true, evidence: "잘못된 입력 후 오류 메시지를 확인함" },
      ],
    },
    history: [
      { at: "2026-10-03", stage: "work", message: "worker가 화면을 구현함", taskId: "login" },
      { at: "2026-10-03", stage: "verify", message: "9 tests passed" },
    ],
    initialFingerprint: "initial",
    fingerprint: "changed",
  }
}

export function marketingMission(): Mission {
  const value = mission()
  value.marketingLeadId = "marketer"
  value.personas.push({
    id: "marketer",
    name: "Marketing Director 참모",
    role: CMO_ROLE,
    agentType: "cursor",
    skills: ["oma-market"],
  })
  value.marketingReview = {
    planKey: "initial-marketing-key",
    reviewerId: "marketer",
    fingerprint: "before-the-plan",
    review: {
      passed: false,
      summary: "추천 채널은 가설이며 광고를 집행하거나 매출을 측정하지 않음",
      findings: ["고객 획득 비용과 ROI는 미측정"],
    },
  }
  return value
}
