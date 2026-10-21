# v0.2 Big Bang Release — Design Document

- **Status:** Approved (Brainstorm complete, 2026-04-22 KST)
- **Scope target:** v0.2 single release (no intermediate publishes)
- **Prerequisites:** `docs/plans/domain-ports-di-seam-design.md` (PR1 design)
- **Depends on memory:** `brainstorm-domain-ports-pr1`, `prd-v0.1`
- **Related PRD:** `docs/prd.md` § 6.2 (To-Be) / § 10 릴리스 계획

---

## 1. 결정 요약

| 축 | 결정 | 근거 |
|---|---|---|
| 스코프 (안정성) | 도메인 포트 PR1~PR4 + PR0 Characterization | PRD v0.2 후보 + 리팩터 리스크 선제 제거 |
| 스코프 (신기능) | A GitHub Issues 어댑터 / B 비용·토큰 예산 / C 라이브 인터벤션 / D OTel·Prometheus | 포트 설계와의 시너지 + 사용자 가치 |
| 보류 | E 세션 기록·재생 | PR4 위에서 v0.3 로 자연스럽게 올리기 |
| 릴리스 전략 | α 빅뱅 (단일 v0.2) + 내부 M0~M3 체크포인트 | 메시징 명확, 포트/기능 정합 |
| 실행 접근법 | 2 Outside-in / Risk-first | 포트 오설계를 실어댑터(A) 로 가장 먼저 검증 |
| TDD 강도 | L3 — 변경 파일 라인 80% / 브랜치 70% CI 게이트 | 빅뱅의 회귀 리스크를 커버리지로 방어 |
| 조직 원칙 | Characterization → 포트 → 실어댑터 → 내부 분할 → 기능 레이어 | PR2·PR3 리팩터의 안전망 확보 |

---

## 2. 내부 마일스톤 (외부 릴리스는 M3 끝에 v0.2 한 번)

```
M0  PR0 Characterization 스위트 잠금 (orchestrator.ts / workspace-manager.ts)
M1a PR1 Tracker/WebhookReceiver/WorkspaceGateway 포트 + Linear 어댑터 래핑 + Contract 스위트
M1b A  GitHub 어댑터 → Contract 스위트 통과 (= 포트 설계 검증 포인트)
M1c PR2 WorkspaceManager 내부 분할 ‖ PR3 Orchestrator 내부 분할 (병렬 가능)
M1d PR4 AgentRunnerPort + ParsedWebhookEvent 도메인 승격
M2  D OTel/Prometheus (독립) → B 비용·토큰 예산 → C 라이브 인터벤션 (PR4 위)
M3  통합 테스트 보강 + 문서 + v0.2 태깅
```

---

## 3. 아키텍처 개요

### 3.1 컴포넌트 맵

```
── Presentation ──────────────────────────────────────────
   apps/dashboard/src/app/api/
     /api/webhook          기존 Linear 수신
   + /api/webhook/github   (A) GitHub 수신
   + /api/intervention     (C) 대시보드→세션 제어 POST
   + /api/metrics          (D) Prometheus scrape
     /api/events           기존 SSE (이벤트 타입 확장)
   apps/cli/src/           기존 CLI 유지

── Application ────────────────────────────────────────────
   packages/core/src/orchestrator/
     orchestrator.ts         facade 유지, 내부 분할 (PR3)
     ├─ webhook-router.ts    (NEW) 이벤트→핸들러 라우팅
     ├─ issue-lifecycle.ts   (NEW) 상태 전이 및 DAG 확인
     └─ orchestrator-core.ts (NEW) runtime state 소유
     completion-handler.ts    유지
     retry-queue.ts           유지 (영속화는 v0.3)
     dag-scheduler.ts         유지
     scoring-service.ts       + 비용 훅 (B)
     + budget-service.ts      (B) 이슈/일일 토큰 예산
     + intervention-bus.ts    (C) 대시보드→세션 FIFO 큐
     agent-runner.ts          AgentRunnerPort 경유 (PR4)

── Domain ────────────────────────────────────────────────
   packages/core/src/domain/
     models.ts                유지
     + ports/
       tracker.ts             (PR1) IssueTracker, WebhookReceiver
       workspace.ts           (PR1) WorkspaceGateway
       agent-runner.ts        (PR4) AgentRunnerPort
     + parsed-webhook-event.ts (PR4) tracker 비의존 도메인
     + budget.ts              (B)
     + intervention.ts        (C)

── Infrastructure ────────────────────────────────────────
   packages/core/src/tracker/
     linear-client.ts              유지 (내부 fn)
     + adapters/linear-adapter.ts  (PR1)
     + adapters/github-adapter.ts  (A)
     + adapters/linear-webhook-receiver.ts (PR1)
     + adapters/github-webhook-receiver.ts (A)
   packages/core/src/workspace/
     workspace-manager.ts            shell, ~150줄 (PR2)
     ├─ worktree-lifecycle.ts        (PR2)
     ├─ delivery-strategy.ts         (PR2)
     └─ safety-net.ts                (PR2)
     + adapters/fs-workspace-gateway.ts (PR1~2)
   packages/core/src/sessions/
     claude/codex/gemini-session.ts  유지
     + adapters/spawn-agent-runner.ts (PR4)
   packages/core/src/observability/
     logger.ts                유지
     + otel-exporter.ts       (D)
     + prom-metrics.ts        (D)
```

### 3.2 의존 방향

```
Presentation → Application → Domain ports ← Infrastructure adapters
```

상향 참조 없음. `domain/ports/*.ts` 는 외부 import 금지(validate.sh 룰 추가).

---

## 4. 핵심 인터페이스 & Contract

### 4.1 IssueTracker (PR1)

```ts
export interface IssueTracker {
  fetchIssuesByStates(states: IssueStateType[]): Promise<Issue[]>
  fetchIssueLabels(issueId: string): Promise<string[]>
  updateIssueState(issueId: string, state: IssueStateType): Promise<void>
  addIssueComment(issueId: string, body: string): Promise<void>
  addIssueLabel(issueId: string, label: string): Promise<void>
}

export type IssueStateType = "todo" | "in_progress" | "done" | "cancelled"
```

**결정**
- 4개 논리 상태 고정. Linear `workflow_states` UUID, GitHub `label+state` 매핑은 어댑터 내부.
- 실패는 `TrackerError`(code, retryable, context) 로 통일.

### 4.2 WebhookReceiver (PR1)

```ts
export interface WebhookReceiver {
  verifySignature(payload: string, signature: string): boolean
  parseEvent(payload: string): ParsedWebhookEvent | null
}

export type ParsedWebhookEvent =
  | { kind: "issue.transitioned"; issueId: string; from: IssueStateType; to: IssueStateType }
  | { kind: "issue.updated"; issueId: string; changedFields: string[] }
  | { kind: "issue.deleted"; issueId: string }
```

**결정**
- 도메인 승격은 PR4 에서 기존 `tracker/types.ts:ParsedWebhookEvent` 를 교체.
- `parseEvent` 가 `null` = 해당 어댑터가 다룰 이벤트 아님 (무시). throw 는 스키마 이탈만.

### 4.3 WorkspaceGateway (PR1 표면, PR2 내부 분할)

```ts
export interface WorkspaceGateway {
  create(issue: Issue): Promise<Workspace>
  cleanup(workspace: Workspace): Promise<void>
  commitUncommitted(workspace: Workspace, message: string): Promise<void>
  deliver(workspace: Workspace, mode: DeliveryMode): Promise<DeliveryResult>
  getCurrentBranch(workspace: Workspace): Promise<string>
  hasChanges(workspace: Workspace): Promise<boolean>
  pushBranch(workspace: Workspace, branch: string): Promise<void>
  createDraftPR(workspace: Workspace, title: string, body: string): Promise<string>
  mergeToMain(workspace: Workspace): Promise<void>
}

export type DeliveryMode = "merge" | "pr"
export type DeliveryResult =
  | { kind: "merged"; commitSha: string }
  | { kind: "pr"; url: string }
```

**결정**
- v0.2 에서는 9개 메소드 공개 표면 **불변**.
- PR2 분할은 내부만: `worktree-lifecycle / delivery-strategy / safety-net`.

### 4.4 AgentRunnerPort (PR4)

```ts
export interface AgentRunnerPort {
  spawn(input: SpawnInput): Promise<RunHandle>
  capabilities(agentType: AgentType): InterventionCapability[]
}

export interface RunHandle {
  readonly attemptId: string
  readonly issueKey: string
  onEvent(h: (e: AgentEvent) => void): Unsubscribe
  send(cmd: InterventionCommand): Promise<void>
  cancel(): Promise<void>
  kill(): Promise<void>
}

export type InterventionCommand =
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "append_prompt"; text: string }
  | { kind: "abort"; reason: string }

export type InterventionCapability = "pause" | "resume" | "append_prompt" | "abort"
```

**결정**
- `capabilities()` 는 **세션 타입별 정적 답변**. UI 가 버튼 비활성화를 사전 판단.
- Claude(stateless) 는 `["append_prompt", "abort"]` 만 지원. `append_prompt` 는 cancel + 합친 프롬프트로 재실행.
- Codex/Gemini ACP 는 네이티브 지원.
- 미지원 명령 수신 시 `InterventionUnsupportedError`.

### 4.5 BudgetService (B, 포트 아님)

```ts
export interface BudgetService {
  checkBeforeSpawn(issue: Issue): Promise<BudgetDecision>
  recordUsage(attemptId: string, usage: TokenUsage): Promise<void>
}

export type BudgetDecision =
  | { allow: true }
  | { allow: false; reason: "issue_cap" | "daily_cap"; used: number; cap: number }

export type TokenUsage = { input: number; output: number; costUsd: number }
```

**설정** (`valley.yaml`):
```yaml
budget:
  per_issue: { tokens: 500000, usd: 2.0 }
  per_day:   { tokens: 5000000, usd: 20.0 }
  on_exceed: block          # block | warn
  allow_override_label: false  # 기본 off (E18)
  pricing:
    claude-sonnet: { input_per_mtok: 3.0, output_per_mtok: 15.0 }
    # 미정의 모델은 0 처리 + WARN
```

### 4.6 Contract Test 구조

```
packages/core/src/__tests__/
  contracts/
    issue-tracker.contract.ts      # ~15 케이스
    webhook-receiver.contract.ts
    workspace-gateway.contract.ts
    agent-runner.contract.ts       # PR4
  fakes/                           # 런타임 번들 제외
    fake-tracker.ts
    fake-workspace-gateway.ts
    fake-agent-runner.ts
  adapters/
    linear-adapter.test.ts         # runIssueTrackerContract("linear", ...)
    github-adapter.test.ts         # runIssueTrackerContract("github", ...) ← A 머지 게이트
    fs-workspace-gateway.test.ts
  integration/
    todo-to-done.test.ts
    retry-exhaust.test.ts
    intervention-flow.test.ts
```

**관용구**
```ts
export function runIssueTrackerContract(
  label: string,
  makeTracker: () => Promise<{ tracker: IssueTracker; seedIssue: (init: Issue) => Promise<string> }>,
) {
  describe(`IssueTracker contract — ${label}`, () => { /* 15 케이스 */ })
}
```

**A 의 머지 조건** = `github-adapter.test.ts` 의 contract 15개 green + 변경 파일 라인 커버리지 80%.

---

## 5. 통합 지점 & 마이그레이션

### 5.1 부트스트랩 (`apps/dashboard/src/lib/bootstrap.ts`)

```ts
const tracker = config.tracker.kind === "github"
  ? new GithubTrackerAdapter({ token, owner, repo })
  : new LinearTrackerAdapter({ apiKey, teamId, teamUuid })

const webhook = config.tracker.kind === "github"
  ? new GithubWebhookReceiver({ secret })
  : new LinearWebhookReceiver({ secret })

const workspace = new FileSystemWorkspaceGateway({ wm: new WorkspaceManager(...) })

const orchestrator = new Orchestrator({
  tracker, webhook, workspace,
  config, logger,
  // PR4 이후
  agentRunner: new SpawnAgentRunner(...),
  budget: new BudgetService(...),
  intervention: new InterventionBus(...),
})
```

**하위 호환**: `tracker.kind` 누락 + `linear:` 섹션 존재 = `linear` 자동 추론.

### 5.2 웹훅 라우팅

- `/api/webhook` (기존, Linear)
- `/api/webhook/github` (신규) — `X-Hub-Signature-256` 헤더 기준
- 두 핸들러 모두 주입된 `WebhookReceiver` 경유, 동일 `ParsedWebhookEvent` 로 Orchestrator 에 전달

### 5.3 Orchestrator 분할 (PR3) 마이그레이션

순서 (각 단계는 characterization green 유지):
1. extract `webhook-router.ts` (handleEvent 분기)
2. extract `issue-lifecycle.ts` (transition, DAG 확인, 완료 처리)
3. residual `orchestrator-core.ts` (state 소유, 슬롯 관리, startup sync)

외부 호출자는 여전히 `Orchestrator` facade 만 참조.

### 5.4 WorkspaceManager 분할 (PR2)

```
workspace-manager.ts (shell, ~150줄)
  ├ worktree-lifecycle.ts  (create/cleanup/getCurrentBranch/hasChanges)
  ├ delivery-strategy.ts   (deliver/pushBranch/createDraftPR/mergeToMain)
  └ safety-net.ts          (commitUncommitted + 자동 감지)
```

`FileSystemWorkspaceGateway` 는 shell 을 composition 래핑.

### 5.5 `valley.yaml` 확장

```yaml
tracker:
  kind: linear     # linear | github
github:
  token_env: GITHUB_TOKEN
  owner: first-fluke
  repo: agent-valley
  webhook_secret: whsec_xxx
  labels:
    todo: "valley:todo"
    in_progress: "valley:wip"
    done: "valley:done"
    cancelled: "valley:cancelled"
budget:
  per_issue: { tokens: 500000, usd: 2.0 }
  per_day:   { tokens: 5000000, usd: 20.0 }
  on_exceed: block
  allow_override_label: false
  pricing:
    claude-sonnet: { input_per_mtok: 3.0, output_per_mtok: 15.0 }
observability:
  otel:
    enabled: false
    endpoint: http://localhost:4317
  prometheus:
    enabled: false
    path: /api/metrics
workspace:
  stale_after_hours: 24  # E29
```

### 5.6 `validate.sh` 변경  [구현됨 — v0.2 M3]

- `bun run test:coverage` 추가 (validate.sh Check 5/5). 전역 임계 라인 80% / 브랜치 70% / 함수 80% / 문장 80%. 임계는 `vitest.config.ts:coverage.thresholds` 에 선언, vitest v8 provider 사용. 현재 측정치: statements 88.15%, branches 76.98%, functions 89.81%, lines 90.30%. `SKIP_COVERAGE=1` 로 로컬 오프트아웃 (CI 금지).
- 500줄 grandfather 예외는 PR2·PR3 완료 이후 제거. (완료 — grandfather 리스트 empty)
- 새 룰: `domain/ports/*.ts` 외부 import 금지.
- 새 룰: tracker 복수 활성화 금지 (`tracker.kind` XOR).
- CI 는 `coverage/lcov.info` + `coverage/index.html` 를 `coverage-report` 아티팩트로 업로드 (retention 14d).

### 5.7 대시보드 UI (C)

- `features/orchestrator/components/InterventionPanel.tsx` 신설. 활성 에이전트 행 클릭 시 pause / abort / append-prompt.
- SSE 이벤트 타입 추가: `agent.paused / agent.resumed / agent.prompt_appended`.
- `POST /api/intervention` body: `{ attemptId, command: InterventionCommand }`. **v0.2 는 127.0.0.1 제한** (middleware). 원격 허용은 v0.3.

### 5.8 Observability (D)

- `logger.ts` 유지. OTel 은 이벤트 병렬 전파, 제거 아님.
- Prometheus counters: `av_agent_runs_total{agent,result}`, `av_agent_duration_seconds`, `av_retry_queue_size`, `av_budget_used_usd{scope}`.
- 둘 다 `enabled=false` 기본, 0 오버헤드.

---

## 6. 엣지 케이스 & 에러 처리

### 6.1 포트/어댑터 경계

| # | 상황 | 대응 |
|---|---|---|
| E1 | GitHub 이슈 label 없이 등록 | 스킵 + WARN + `issue.untagged` 메트릭 |
| E2 | Linear `workflow_states` UUID 불일치 | startup 즉시 실패, 수정 위치 포함 에러 |
| E3 | 두 tracker 동시 활성 | Zod XOR 강제, config 에러 |
| E4 | Webhook 서명 실패 | 403 + WARN + payload 해시만 로그 |
| E5 | GitHub `ping` 등 비도메인 이벤트 | `parseEvent` → null, Orchestrator 무시 |
| E6 | Tracker API 일시 장애 (502/429) | `RetryExhaustReason` 분리 — `infra_failure` 는 pending 유지, `agent_failure` 만 Cancelled |

### 6.2 DAG & 생명주기

| # | 상황 | 대응 |
|---|---|---|
| E7 | `blocked_by` 삭제됨 | DAG 재계산에서 무시, INFO |
| E8 | 사이클 | 로그 + 보류 + `av_dag_cycles_total` |
| E9 | spawn 중 외부 상태 변경 | spawn 직후 재확인 → in_progress 아니면 kill + cleanup |
| E10 | Todo 웹훅 중복 수신 | `parsed.eventId` 기반 idempotency 캐시 60초 |

### 6.3 Intervention (C)

| # | 상황 | 대응 |
|---|---|---|
| E11 | 세션 종료 직전 pause | `RunAlreadyTerminatedError` + UI silent |
| E12 | Claude 에 pause | `capabilities()` 사전 조회로 UI 차단, 서버는 `InterventionUnsupportedError` |
| E13 | cancel timeout | 5s 후 SIGKILL → 새 세션 |
| E14 | 진행 중 예산 초과 | 진행 세션 완주, 신규 spawn 차단 |
| E15 | 충돌 명령 동시 전송 | FIFO 큐 + 마지막 승자 |

### 6.4 Budget (B)

| # | 상황 | 대응 |
|---|---|---|
| E16 | 일일 상한 초과 | 기존 세션 완주, 이후 차단 + 코멘트 |
| E17 | pricing 맵 누락 모델 | 0 처리 + WARN |
| E18 | `override:budget` 라벨 | 기본 off. `allow_override_label: true` 옵트인 시 audit log 남기고 bypass |
| E19 | 토큰 사용량 미보고 (Gemini 일부) | null → 차감 skip + WARN 메트릭 |

### 6.5 리팩터 / 마이그레이션

| # | 상황 | 대응 |
|---|---|---|
| E20 | characterization 실패 | PR 블록. 의도된 변경이면 characterization 수정 커밋 선행 |
| E21 | ParsedWebhookEvent 승격으로 `webhook-handler.test.ts` 깨짐 | 도메인 승격과 테스트 마이그레이션 한 덩어리 |
| E22 | grandfather 제거 후 다른 파일 초과 | validate.sh 즉시 차단, 사전 full scan |

### 6.6 Observability (D)

| # | 상황 | 대응 |
|---|---|---|
| E23 | OTel 엔드포인트 실패 | 내부 swallow + 카운터. hot path 영향 0 |
| E24 | `/api/metrics` 내부 예외 | 빈 메트릭 + 에러 카운터 (500 반환 금지) |
| E25 | 비활성 상태 | 초기화 skip, no-op 보장 |

### 6.7 워크스페이스

| # | 상황 | 대응 |
|---|---|---|
| E26 | 디스크 부족 | `WorkspaceError.retryable=false` → Cancelled + 코멘트 |
| E27 | 머지 충돌 | 기존 safety-net → PR 모드 폴백 + 리뷰 요청 |
| E28 | abort 시 uncommitted | safety-net 선행 커밋 → cleanup, delivery 스킵 |
| E29 | stale worktree | `workspace.stale_after_hours`(기본 24h) 초과 시 force cleanup + INFO |

### 6.8 에러 메시지 컨벤션

```ts
class ValleyError extends Error {
  constructor(
    public code: string,
    message: string,
    public context: Record<string, unknown>,
    public fixHint: string,
    public retryable: boolean,
  ) { super(message) }
}
```

모든 신규 에러는 5필드(`code / message / context / fixHint / retryable`) 를 포함.

### 6.9 보안 엣지

- **GitHub 토큰 scope**: `issues:write`, `pull_requests:write`, `contents:write`. CLI 에서 사전 검증.
- **/api/intervention**: v0.2 는 127.0.0.1 제한 (Next.js middleware). 원격은 v0.3.
- **프롬프트 주입**: GitHub 이슈 본문도 Linear 와 동일 sanitize. 어댑터 책임.

### 6.10 롤백 플랜

1. 심각한 회귀 시 v0.1.x 태그 복귀 가능 (facade 뒤 모든 리팩터 은폐, public API 동일).
2. B/C/D 는 설정 기본값 off → 설정 삭제만으로 비활성화.
3. 포트 자체 롤백 불가 → 설계 오류는 v0.2.1 핫픽스로 contract 수정. 수용 리스크.

---

## 7. 머지 게이트 (CI / Reviewer 체크리스트)

각 PR 머지 전:

- [ ] `./scripts/harness/validate.sh` green (레이어 위반 / secret / 500줄 / domain/ports import 룰)
- [ ] `bun test` 전체 green
- [ ] 변경 파일 라인 커버리지 ≥ 80%, 브랜치 ≥ 70%
- [ ] PR0 characterization 스위트 무변경 통과
- [ ] 신규 에러는 ValleyError 5필드 준수
- [ ] 포트/어댑터 변경 시 contract 스위트 추가 및 통과 (`adapters/*.test.ts`)
- [ ] 하위 호환 확인: 기존 `valley.yaml` 그대로 동작

M3 (v0.2 태깅) 전:

- [ ] 500줄 grandfather 예외 완전 제거
- [ ] integration 테스트 3종 (todo-to-done / retry-exhaust / intervention-flow) green
- [ ] 문서 업데이트: `AGENTS.md`, `README.md`, `docs/prd.md`, `docs/specs/*`

---

## 8. Out of Scope (v0.2)

- E 세션 기록·재생 (PR4 위에서 v0.3)
- Retry 큐 영속화 / Dead-letter
- 뮤테이션 테스트 (Stryker) — critical path 만 v0.3 에서 검토
- `/api/intervention` 의 원격 허용 (Supabase 세션 검증) — v0.3
- Jira/기타 tracker 어댑터

---

## 9. 다음 액션

- `/plan` 워크플로로 M0 PR0 부터 태스크 분해
- 또는 `symphony-implementer` 에 이 문서를 컨텍스트로 PR0 직접 착수
