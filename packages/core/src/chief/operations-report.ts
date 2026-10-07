import { assessMetricTargets } from "./organization"
import { routeEvidence } from "./routing"
import type { Mission } from "./types"

export function operationsEvidence(mission: Mission) {
  const runs = mission.operations?.runs ?? []
  const known = runs.filter((run) => run.costUsd !== null)
  return {
    measuredRuns: runs.length,
    recordedTokenRuns: runs.filter((run) => run.inputTokens !== null && run.outputTokens !== null).length,
    unknownUsageRuns: runs.filter((run) => run.inputTokens === null || run.outputTokens === null).length,
    knownEstimatedCostUsd: known.reduce((sum, run) => sum + (run.costUsd ?? 0), 0),
    unknownCostRuns: runs.length - known.length,
    totalEstimatedCostUsd:
      known.length === runs.length && runs.length ? known.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) : null,
    pricingBasis:
      "Estimates from configured input/output prices and actual adapter-reported tokens; excludes unreported cache/reasoning/subagent usage and subscription billing.",
    routeQuality: routeEvidence(mission).slice(0, 20),
    reviewPolicy: mission.operatingPolicy?.reviewVendor ?? "legacy independent Actor",
    skillCompatibility: mission.operatingPolicy?.skillCompatibility
      ? {
          mode: mission.operatingPolicy.skillCompatibility.mode,
          recentChecks: mission.history.filter((entry) => entry.stage === "skill-compatibility").slice(-10),
        }
      : undefined,
    recentRuns: runs.slice(-20),
    crossVendorReviews: mission.operations?.reviewDecisions.slice(-20) ?? [],
    organizationContext: mission.organizationContext,
    metricAssessments: assessMetricTargets(mission.organizationContext, mission.operatingPolicy?.metricTargets ?? []),
  }
}

/** Facts are appended outside the LLM narrative so unknowns and fallback reviews remain visible. */
export function operationsReportLines(mission: Mission): string[] {
  if (!mission.operations && !mission.organizationContext && !mission.operatingPolicy) return []
  const evidence = operationsEvidence(mission)
  return [
    `실제 실행 ${evidence.measuredRuns}회 / token usage 기록 ${evidence.recordedTokenRuns}회 / usage 미확인 ${evidence.unknownUsageRuns}회`,
    `기록된 token·설정 단가 기반 부분 비용 추정 USD ${evidence.knownEstimatedCostUsd.toFixed(6)} / 비용 미확인 ${evidence.unknownCostRuns}회 / 전체 추정 ${evidence.totalEstimatedCostUsd === null ? "미확인" : `USD ${evidence.totalEstimatedCostUsd.toFixed(6)}`}`,
    `최근 독립 리뷰 배정: 다른 vendor ${evidence.crossVendorReviews.filter((review) => review.crossVendor).length}회 / 동일 vendor fallback ${evidence.crossVendorReviews.filter((review) => !review.crossVendor).length}회 / 실제 리뷰 통과 ${evidence.crossVendorReviews.filter((review) => review.outcome === "passed").length}회`,
    `vendor 리뷰 정책: ${evidence.reviewPolicy}`,
    ...(evidence.skillCompatibility
      ? [
          `OMA 스킬 읽기·참조 정책: ${evidence.skillCompatibility.mode}; AV 실행 환경 또는 작업 품질 인증이 아닙니다.`,
          ...evidence.skillCompatibility.recentChecks.map((entry) => `${entry.at}: ${entry.message}`),
        ]
      : []),
    ...(mission.organizationContext
      ? [
          `계획·리뷰에 제공한 조직 근거: 승인 memory ${mission.organizationContext.memories.length}개 / 과거 outcome ${mission.organizationContext.outcomes.length}개 / 기록된 metric sample ${mission.organizationContext.metrics.length}개`,
        ]
      : []),
    ...evidence.metricAssessments.map(
      (metric) => `${metric.criterion}: ${metric.passed ? "기록된 측정값 기준 통과" : "미충족"}; ${metric.evidence}`,
    ),
    "비용은 실제 청구액이 아닙니다. 미보고 cache·reasoning·하위 agent token 및 구독 요금은 포함하지 않습니다.",
    ...evidence.routeQuality.map(
      (route) =>
        `${route.actorType}/${route.model ?? "CLI 기본값"}: 실제 work ${route.samples}회, 독립 리뷰 통과 ${route.successes}회, 성공 산출물당 누적 비용 추정 ${route.successfulDeliverableCostUsd === null ? "미확인" : `USD ${route.successfulDeliverableCostUsd.toFixed(6)}`}`,
    ),
    ...evidence.recentRuns
      .filter((run) => run.stage === "work")
      .map(
        (run) =>
          `${run.taskId ?? run.runId}: 실제 ${run.actorType}/${run.model ?? "CLI 기본값"}, 보고 모델 ${run.actualModel ?? "미확인"}, ${run.elapsedMs === null ? "소요시간 미확인" : `${run.elapsedMs}ms`}, ${run.outcome}; ${run.routingReason ?? "지정된 Actor"}`,
      ),
    ...evidence.crossVendorReviews.map(
      (review) =>
        `${review.taskId}: 작업 ${review.workerActorType} → 리뷰 ${review.reviewerActorType}, ${review.crossVendor ? "다른 vendor" : "동일 vendor fallback"}, 결과 ${review.outcome ?? "배정만 기록"}; ${review.reason}`,
    ),
    ...(mission.organizationContext
      ? [
          "조직 context는 저장된 과거 근거와 운영자 기록 측정값입니다. 과거 통과는 현재 산출물의 승인이나 독립적으로 검증된 ROI를 뜻하지 않습니다.",
        ]
      : []),
  ]
}
