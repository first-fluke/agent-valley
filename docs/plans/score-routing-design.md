# Score-Based Model Routing Design

> ISO/IEC 14143 기능점수 분석 기반 이슈 난이도 자동 판별 및 모델 라우팅

## 1. 개요

이슈 생성 시 LLM이 ISO/IEC 14143 기능점수를 분석하고, ISO/IEC 20926 IFPUG 복잡도를 참고하여
1~10점 난이도를 부여한다. 점수에 따라 유저가 설정한 easy/medium/hard 모델로 자동 위임한다.

### 진입 경로

| 경로 | 분석 시점 | 블로킹 여부 |
|---|---|---|
| CLI (`composer issue`) | 이슈 생성 시 동기적 분석 | 블로킹 (사용자 대기) |
| 웹훅 (Linear UI 생성) | Todo 이벤트 수신 시 비동기 분석 | **논블로킹** — 즉시 defaultAgentType으로 라우팅, 백그라운드 분석 |

### 라우팅 우선순위

```
1. model:* 레이블 (수동 오버라이드, Phase 1 호환)
2. score:N 레이블 → SCORE_ROUTING 매핑
3. config.agentType (defaultAgentType)
```

## 2. Domain 모델 변경

**파일:** `src/domain/models.ts`

```ts
export interface Issue {
  // ... 기존 필드 유지 ...
  score: number | null  // ISO/IEC 14143 기능점수 (1~10), null = 미분석
}

/**
 * ISO/IEC 14143 기능점수 분석 결과.
 * LLM이 이슈 제목+설명을 분석하여 산출.
 */
export interface ScoreAnalysis {
  /** 최종 점수 (1~10) */
  score: number
  /** 분석 단계: quick(간소화) 또는 detailed(IFPUG 정밀) */
  phase: "quick" | "detailed"
  /** ISO/IEC 14143 5대 기능 유형별 식별 수 */
  functionTypes: {
    /** External Input — 외부에서 시스템으로 데이터 입력 */
    ei: number
    /** External Output — 시스템에서 외부로 데이터 출력 */
    eo: number
    /** External Inquiry — 외부 조회 (입력+출력 조합) */
    eq: number
    /** Internal Logical File — 시스템 내부 유지 데이터 그룹 */
    ilf: number
    /** External Interface File — 외부 시스템 참조 데이터 */
    eif: number
  }
  /** LLM 판단 근거 (로그/디버깅용) */
  reasoning: string
}
```

**주의:** `src/tracker/types.ts`의 `linearIssueNodeSchema`에 `score: z.null().default(null)` 추가 필요.
Linear 웹훅 payload에 score 필드가 없으므로 기본값 null.

## 3. Config 변경

**파일:** `src/config/env.ts`

### 새 환경변수

| 변수 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `SCORING_MODEL` | string | `"haiku"` | 점수 분석용 LLM 모델 (비용 최적화용 저렴한 모델) |
| `SCORE_ROUTING` | JSON | `undefined` | 점수 구간별 모델 매핑 (없으면 점수 라우팅 비활성) |

### SCORE_ROUTING 스키마 (Zod 검증)

```ts
const scoreRoutingTierSchema = z.object({
  min: z.number().int().min(1).max(10),
  max: z.number().int().min(1).max(10),
  agent: z.enum(["claude", "codex", "gemini"]),
})

const scoreRoutingSchema = z.object({
  easy: scoreRoutingTierSchema,
  medium: scoreRoutingTierSchema,
  hard: scoreRoutingTierSchema,
}).refine(
  (v) => v.easy.max < v.medium.min && v.medium.max < v.hard.min,
  "Score tiers must not overlap. Fix: ensure easy.max < medium.min < hard.min"
)
```

### .env 예시

```env
SCORING_MODEL=haiku
SCORE_ROUTING='{"easy":{"min":1,"max":3,"agent":"gemini"},"medium":{"min":4,"max":7,"agent":"codex"},"hard":{"min":8,"max":10,"agent":"claude"}}'
```

**설계 결정:** `min` 필드를 명시적으로 포함하여 범위 경계를 machine-validatable하게 만든다.
`score: null`이면 점수 라우팅 전체를 스킵하고 defaultAgentType으로 폴스루.

## 4. 레이어 분리

### 4.1 ScoringService (Application 레이어)

**파일:** `src/orchestrator/scoring-service.ts`

```ts
export interface ScoringService {
  analyze(title: string, description: string): Promise<ScoreAnalysis>
}
```

- LLM 호출하여 ScoreAnalysis 반환
- Linear API 호출 금지 (레이어 위반)
- 2단계 분석 로직:
  - CLI 경로: 단일 프롬프트로 quick + conditional IFPUG 재가중치를 한 번에 처리
  - 웹훅 경로: 백그라운드 fire-and-forget이므로 2단계 순차 호출 허용

### 4.2 Linear 레이블 부착 (Infrastructure 레이어)

**파일:** `src/tracker/linear-client.ts`

```ts
// 기존 클라이언트에 메서드 추가
addIssueLabel(issueId: string, labelName: string): Promise<void>
```

- Orchestrator가 ScoringService 결과를 받은 후 별도로 호출
- `score:N` 레이블이 Linear workspace에 없으면 `labelCreate` → `issueLabelConnect` 순서
- 실패 시 로그만 남기고 라우팅에는 영향 없음 (score는 이미 Issue.score에 있으므로)

## 5. 라우팅 변경

**파일:** `src/config/routing.ts`

기존 `resolveRoute`는 수정하지 않음. 새 함수 추가:

```ts
export function resolveRouteWithScore(
  issue: Issue,
  config: Config,
): ResolvedRoute {
  // 1. 기존 레이블 라우팅 (model:* 포함)
  const labelRoute = resolveRoute(issue, config)
  if (labelRoute.matchedLabel !== null) return labelRoute

  // 2. 점수 기반 라우팅
  if (issue.score !== null && config.scoreRouting) {
    const tier = matchScoreTier(issue.score, config.scoreRouting)
    if (tier) {
      return {
        workspaceRoot: config.workspaceRoot,
        agentType: tier.agent,
        deliveryMode: config.deliveryMode,
        matchedLabel: `score:${issue.score}`,
      }
    }
  }

  // 3. 폴스루: defaultAgentType
  return {
    workspaceRoot: config.workspaceRoot,
    agentType: config.agentType,
    deliveryMode: config.deliveryMode,
    matchedLabel: null,
  }
}
```

## 6. 웹훅 경로 비동기 처리

**핵심 제약:** Linear 웹훅 타임아웃 ~10초. LLM 분석으로 블로킹하면 안 됨.

### 플로우

```
웹훅 수신 (Todo 이벤트)
  ├─ score:* 레이블 있음 → Issue.score 파싱 → 즉시 라우팅
  └─ score:* 레이블 없음
       ├─ SCORE_ROUTING 미설정 → defaultAgentType으로 즉시 라우팅
       └─ SCORE_ROUTING 설정됨
            ├─ 즉시: defaultAgentType으로 에이전트 시작 (블로킹 방지)
            └─ 백그라운드: ScoringService.analyze() → score:N 레이블 부착
               (다음 실행부터 정확한 모델 사용)
```

**설계 결정:** 첫 실행은 defaultAgentType으로 시작하고, 점수 분석이 완료되면
레이블만 부착한다. 이 이슈가 재시도(retry)되거나 다시 Todo로 돌아올 때
`score:N` 레이블이 이미 있으므로 정확한 모델로 라우팅된다.

## 7. CLI 경로 단일 프롬프트

**핵심 제약:** CLI에서 expand + scoring = 최대 2~3회 LLM 호출은 체감 느림.

### 해결: 이슈 확장 + 점수 분석 통합 프롬프트

기존 `expandWithClaude`의 `EXPAND_PROMPT`를 확장하여 이슈 확장과 점수 분석을 1회 호출로 처리.

```
출력 형식:
TITLE: ...
DESCRIPTION: ...
SCORE: 7
SCORE_PHASE: quick
SCORE_REASONING: EI 2개, EO 1개, ILF 1개 식별. API 엔드포인트 + DB 스키마 변경 포함.
```

점수가 4~7 범위이면 **같은 프롬프트 내에서** IFPUG 재가중치를 적용하도록 지시.
LLM에게 "4~7점이면 DET/RET/FTR까지 추정하여 재평가하라"는 조건부 지시를 포함.
→ 1회 호출로 2단계 분석 완료.

## 8. Linear 레이블 사전 생성

`score:1` ~ `score:10` 레이블이 Linear workspace에 미리 존재해야 한다.

### 선택지

- **(A) CLI setup에서 자동 생성:** `composer setup` 실행 시 10개 레이블 일괄 생성
- **(B) On-demand 생성:** `addIssueLabel` 호출 시 레이블 없으면 `labelCreate` 후 연결

**선택: B (on-demand)** — setup 단계 복잡도를 높이지 않고, 필요한 레이블만 생성.
`labelCreate`는 멱등하지 않으므로 "이름으로 검색 → 없으면 생성 → 연결" 패턴 사용.

## 9. 대시보드 작업과의 충돌

| 파일 | 대시보드 (plan.json) | 점수 라우팅 | 충돌 |
|---|---|---|---|
| `src/domain/models.ts` | T2: LedgerEvent 타입 추가 | score 필드 + ScoreAnalysis | 낮음 (서로 다른 타입) |
| `src/config/env.ts` | T3: Supabase 환경변수 추가 | SCORING_MODEL, SCORE_ROUTING | 낮음 (서로 다른 필드) |

두 작업 모두 additive이므로 git merge 시 자동 해결 가능.
`models.ts` 수정 시 파일 하단에 추가하여 diff 영역 분리 권장.

## 10. 구현 순서

| 순서 | 작업 | 의존성 |
|---|---|---|
| S1 | Domain: `Issue.score` + `ScoreAnalysis` 타입 추가 | 없음 |
| S2 | Config: `SCORING_MODEL`, `SCORE_ROUTING` + Zod 스키마 | 없음 |
| S3 | Infrastructure: `linear-client.ts`에 `addIssueLabel` | 없음 |
| S4 | Application: `ScoringService` 구현 | S1 |
| S5 | Routing: `resolveRouteWithScore` 함수 | S1, S2 |
| S6 | CLI: 통합 프롬프트 (expand + score) | S1, S4 |
| S7 | Orchestrator: 웹훅 경로 비동기 스코어링 연동 | S3, S4, S5 |
| S8 | Tracker: `score:*` 레이블 파싱 → `Issue.score` 주입 | S1 |

S1, S2, S3은 병렬 가능.
