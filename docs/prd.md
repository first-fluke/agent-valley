# Agent Valley — Product Requirements Document (PRD)

- **문서 버전:** v0.2
- **최종 업데이트:** 2026-04-22
- **오너:** otti.nuna@gmail.com
- **상태:** Draft (현행 구현 기준 역공학 + 차기 릴리스 요구사항)
- **관련 문서:**
  - Symphony 7-컴포넌트 스펙: `docs/specs/`
  - 아키텍처 레이어/제약: `docs/architecture/LAYERS.md`, `docs/architecture/CONSTRAINTS.md`
  - 설계 플랜: `docs/plans/*.md`
  - 공통 에이전트 가이드: `AGENTS.md`

---

## 1. 제품 한 줄 정의

**Linear 이슈를 받으면 Claude / Codex / Gemini 에이전트가 격리된 git worktree에서 병렬로 코드를 작성·머지하는 에이전트 오케스트레이션 플랫폼.** 사용자는 이슈만 등록하고, 실행·재시도·머지·보고는 Agent Valley 가 책임진다.

핵심 원칙: **Agent Valley 는 스케줄러/러너이며 에이전트의 비즈니스 로직(코드 작성·PR 생성)에 관여하지 않는다.** 생명주기 상태(Todo → In Progress → Done / Cancelled) 전이와 결과 요약 보고만 담당한다.

---

## 2. 배경과 문제

### 2.1 문제
- 반복적 실무 이슈(버그, 소규모 리팩터, 테스트 작성)는 수동으로 에이전트 CLI를 돌리기엔 비용이 크고, 장시간 자리를 비울 수 없다.
- 여러 에이전트(Claude Code / Codex / Gemini CLI)는 각기 다른 프로토콜·세션 모델을 가지므로 일관된 러너를 직접 구축하기 어렵다.
- 병렬 실행 시 워크스페이스 충돌, 재시도, 실패 복구, 의존성 이슈 순서 관리가 개별 사용자에게 과도한 부담이다.

### 2.2 기회
- Linear 웹훅 + 로컬 오케스트레이터 + git worktree 조합으로 "이슈 = 작업 단위" 자동 실행이 가능하다.
- ISO/IEC 14143 기능점수 기반 난이도 스코어링으로 easy/medium/hard 이슈를 적절한 모델에 자동 위임해 비용을 최적화할 수 있다.
- 팀 대시보드(Supabase ledger) 로 멀티 노드 가시성을 제공해 "누가 어떤 이슈를 돌리는지" 실시간 공유할 수 있다.

---

## 3. 타겟 사용자 및 유스케이스

| 페르소나 | 맥락 | 핵심 유스케이스 |
|---|---|---|
| 1인 개발자 (Solo Builder) | 개인 프로젝트 / 사이드 프로젝트 | Linear에 이슈 등록 → 잠자는 동안 Claude 가 수정 → 아침에 PR 리뷰 |
| 소규모 팀 (2~10인) | 스타트업 / 스쿼드 | 스코프 레이블 기반 다중 레포 라우팅, 팀 대시보드 공유 |
| 에이전트 연구자 | 멀티 에이전트 실험 | SessionFactory 로 커스텀 에이전트 플러그인 추가, 벤치마킹 |

### 주요 사용 시나리오
1. **무인 자동 처리:** `av issue "fix auth bug"` → 웹훅 → 에이전트 자동 실행 → 자동 머지
2. **대규모 작업 분해:** `av issue --breakdown "refactor auth"` → LLM이 서브이슈 DAG로 분해, 의존성 순서대로 순차 실행
3. **비용 최적화 라우팅:** score:2 → gemini, score:5 → codex, score:9 → claude 로 자동 배분
4. **멀티 레포 운영:** `scope:backend` 레이블 → 백엔드 레포 worktree 에서 실행

---

## 4. 제품 목표 (2026 H1)

### 4.1 비즈니스 목표
- G1. **이슈 처리 자동화율:** 수동 개입 없이 완료되는 이슈 비율 ≥ 60%
- G2. **CI 1회차 통과율:** 에이전트 생성 PR 의 CI 첫 시도 통과율 ≥ 70%
- G3. **온보딩 시간:** `install.sh` → 첫 이슈 자동 처리까지 ≤ 15 분

### 4.2 비목표 (Out of Scope)
- Linear 이외 이슈 트래커(Jira, GitHub Issues)의 1차 지원 — 포트는 정의하되 어댑터 구현은 후속
- 에이전트 자체의 프롬프트/추론 품질 개선 — 에이전트 벤더에 위임
- 웹 기반 원격 오케스트레이터 호스팅 — 로컬 실행이 기본

---

## 5. 성공 지표 (Metrics)

| # | 지표 | 정의 | 목표 |
|---|---|---|---|
| M1 | Time to PR | 이슈 할당 → PR 생성까지 p50 | ≤ 20분 (소규모 버그 기준) |
| M2 | CI Pass Rate | 생성 PR의 1회차 CI 성공 비율 | ≥ 70% |
| M3 | Retry Rate | 재시도 큐 진입 이슈 비율 | ≤ 20% |
| M4 | Cancelled Rate | 최대 재시도 초과로 Cancelled 전환 비율 | ≤ 10% |
| M5 | MAX_PARALLEL 활용률 | 동시 실행 에이전트 / 최대 한도 평균 | 30~70% |
| M6 | Doc Freshness | `AGENTS.md` 마지막 업데이트 이후 경과 일수 | ≤ 30일 |

측정 수단: 구조화 로그(JSON) + 팀 대시보드 ledger 이벤트(`agent.start/done/failed/cancelled`).

---

## 6. 제품 범위 (Scope)

### 6.1 현재 제공 기능 (As-Is)

| 카테고리 | 기능 | 구현 위치 |
|---|---|---|
| CLI | `av setup / invite / up / down / dev / status / top / logs / issue / login / logout` | `apps/cli/src/` |
| 이슈 생성 | Claude 기반 설명 확장, `--raw/--parent/--blocked-by/--scope/--breakdown` 옵션 | `apps/cli/src/issue.ts`, `breakdown.ts` |
| 웹훅 수신 | Linear HMAC-SHA256 서명 검증 후 오케스트레이터 디스패치 | `apps/dashboard/src/app/api/webhook/route.ts`, `packages/core/src/tracker/webhook-handler.ts` |
| 오케스트레이션 | 상태 머신, 재시도 큐(60s × 2^n, 최대 3회), DAG 스케줄러, 동시성 제한 | `packages/core/src/orchestrator/*` |
| 워크스페이스 | 이슈별 git worktree 생성/정리, 자동 머지 또는 드래프트 PR | `packages/core/src/workspace/workspace-manager.ts` |
| 에이전트 세션 | Claude(NDJSON) / Codex(JSON-RPC stdio) / Gemini(ACP + CLI 폴백) 플러그인 | `packages/core/src/sessions/*` |
| 대시보드 | Next.js 16 + PixiJS 오피스 씬, 시스템 메트릭, SSE 실시간 업데이트, 팀 HUD | `apps/dashboard/src/app`, `features/office`, `features/team` |
| 스코어링 | ISO/IEC 14143 기능점수 분석 → easy/medium/hard 모델 라우팅 | `packages/core/src/orchestrator/scoring-service.ts` |
| 팀 대시보드 | Supabase auth + ledger 이벤트 브로드캐스트, 리플레이 | `packages/core/src/relay/*`, `supabase/migrations/001_team_dashboard.sql` |
| 관측성 | JSON/text 구조화 로그, `/api/status` 스냅샷, `/api/events` SSE, `/api/health` | `packages/core/src/observability/logger.ts` |
| 관측성 (v0.2) | OpenTelemetry OTLP HTTP 트레이스 + Prometheus `/api/metrics` (기본 off, `valley.yaml observability` 섹션으로 활성화) | `packages/core/src/observability/otel-exporter.ts`, `prom-metrics.ts` |
| GitHub 어댑터 (v0.2) | `IssueTracker` / `WebhookReceiver` 포트의 GitHub 구현 + `POST /api/webhook/github` | `packages/core/src/tracker/adapters/github-adapter.ts`, `github-webhook-receiver.ts` |
| 에이전트 예산 (v0.2) | 이슈당 / 일별 토큰·비용 한도. spawn 직전 `BudgetService.checkBeforeSpawn` 에서 차단 → cancelled 전이 | `packages/core/src/orchestrator/budget-service.ts` |
| 라이브 인터벤션 (v0.2) | `POST /api/intervention` (pause / resume / append_prompt / abort), `InterventionBus` FIFO, 대시보드 `InterventionPanel` UI | `packages/core/src/orchestrator/intervention-bus.ts`, `apps/dashboard/src/app/api/intervention/route.ts` |
| 멀티 레포 라우팅 | 레이블 기반 `workspace_root` / `agent_type` / `delivery_mode` 분기 | `packages/core/src/config/routing.ts` |
| 보안 | HMAC 검증, 워크스페이스 격리, 프롬프트 주입 방어, secret gitignore, 인터벤션 127.0.0.1 제한 (v0.2) | `docs/harness/SAFETY.md` 참조 |

### 6.2 v0.2 에서 완료된 항목
- F1. ✅ **Tracker 포트 + GitHub 어댑터** — `IssueTracker / WebhookReceiver` 포트로 Linear + GitHub 어댑터 동일 경로 사용.
- F2. ✅ **Workspace 포트 분리** — `WorkspaceManager` 파사드 뒤에 `FileSystemWorkspaceGateway` 도입, 내부 모듈 3개(`worktree-lifecycle / delivery-strategy / safety-net`) 로 분할.
- F3. ✅ **Orchestrator 분할** — `WebhookRouter / IssueLifecycle / OrchestratorCore / InterventionBus` SRP 분리.
- F4. ✅ **ParsedWebhookEvent 도메인 승격** — Linear 의존성 제거.
- F5. ✅ **AgentRunnerService 포트화** — `AgentRunnerPort` + `SpawnAgentRunnerAdapter` 도입, 인터벤션용 `RunHandle` 노출.
- F6. ✅ **관측성 / 예산 / 인터벤션 신기능** — OTel + Prometheus, Budget, Live intervention 추가 (기본 off).

### 6.2b 차기 후보 (v0.3+)
- 인터벤션 원격 접근 (서명 세션 토큰)
- 에이전트 레코딩 세션 + 결정론적 재생
- 팀 대시보드 대용량 이벤트 파티셔닝
- Jira 어댑터

### 6.3 명시적 비범위
- 에이전트 실행 결과 품질 평가 모델(자체 LLM judge)
- 브라우저에서 실행되는 원격 러너
- Linear 워크플로우 상태를 커스텀 상태 이름으로 완전 자유화 (현재는 `todo/in_progress/done/cancelled` 4개 고정)

---

## 7. 시스템 개요

### 7.1 아키텍처 레이어 (현행)
```
Presentation   apps/dashboard/src/app/api/*   Next.js Route Handlers
               apps/cli/src/                  commander 기반 av CLI
       ↓
Application    packages/core/src/orchestrator/  Orchestrator + RetryQueue + DagScheduler + AgentRunnerService
       ↓
Domain         packages/core/src/domain/        Issue / Workspace / RunAttempt / DAG / Ledger (pure types)
       ↓
Infrastructure packages/core/src/tracker/       Linear GraphQL + webhook HMAC
               packages/core/src/workspace/     git worktree 라이프사이클
               packages/core/src/sessions/      Claude / Codex / Gemini AgentSession
               packages/core/src/config/        Zod YAML loader
               packages/core/src/observability/ logger
               packages/core/src/relay/         Supabase ledger bridge
```
의존 방향은 반드시 아래쪽으로만 흐른다. 상위 참조는 위반(`docs/architecture/LAYERS.md`).

### 7.2 핵심 불변식
- **상태 단일 권한:** `OrchestratorRuntimeState`(activeWorkspaces, retryQueue, isRunning, lastEventAt) 는 오직 `Orchestrator` 만 변경한다.
- **경계 검증:** 외부 입력(이슈 본문, Linear API 응답, 환경변수)은 진입점에서만 검증하고 내부에서는 신뢰한다.
- **최대 파일 500줄 / 레이어 위반 금지 / 시크릿 하드코딩 금지** — `scripts/harness/validate.sh` 로 강제.

### 7.3 데이터 흐름 (웹훅)
```
Linear webhook POST
  → /api/webhook → webhook-handler.verifySignature (HMAC-SHA256)
  → parseWebhookEvent → Orchestrator.handleEvent
    ├── Todo            → updateIssueState(inProgress) → handleIssueInProgress
    ├── InProgress      → DAG check → WorkspaceManager.create → AgentRunner.spawn
    └── Left InProgress → AgentRunner.kill → WorkspaceManager.cleanup
  → 세션 완료
    ├── 성공: 변경사항 감지 → 머지/PR → addIssueComment(요약) → updateIssueState(done)
    └── 실패: RetryQueue 진입 (60s × 2^n, 3회) → 초과 시 cancelled + 에러 코멘트
```

---

## 8. 기능 요구사항 (Functional Requirements)

### FR-1. 이슈 수신 및 검증
- FR-1.1 Linear 웹훅 POST 수신 시 HMAC-SHA256 서명 검증 실패 → 403 응답 + WARN 로그 후 폐기.
- FR-1.2 `issue.update` 이벤트에서 이슈 ID, 상태, 레이블을 추출한다. 스키마 이탈 시 즉시 400 반환.
- FR-1.3 이슈 본문은 untrusted 로 취급, 프롬프트 템플릿에 삽입하기 전 sanitize 한다.

### FR-2. 상태 머신 및 생명주기
- FR-2.1 Todo → In Progress 전이는 Orchestrator 가 Linear API 로 수행한다. 실패 시 재시도 큐에 진입한다.
- FR-2.2 동일 이슈가 이미 `activeWorkspaces` 에 있으면 재진입을 스킵한다.
- FR-2.3 `MAX_PARALLEL`(하드웨어 자동 탐지, 기본값 `cores/2`) 초과 시 `waitingIssues` 로 대기.
- FR-2.4 In Progress 이탈 이벤트는 실행 중인 세션을 즉시 kill 하고 워크스페이스를 정리한다.

### FR-3. DAG 의존성 스케줄링
- FR-3.1 `blocked_by` 관계를 가진 이슈는 모든 블로커가 Done 이 될 때까지 대기한다.
- FR-3.2 블로커 완료 시 캐스케이드하여 해제된 이슈를 자동 디스패치한다.
- FR-3.3 사이클은 탐지 후 로그만 남기고 이슈는 보류 상태로 둔다(무한 루프 방지).

### FR-4. 워크스페이스 관리
- FR-4.1 이슈 키 기준으로 `WORKSPACE_ROOT/{identifier}` 경로에 git worktree 를 생성한다.
- FR-4.2 `delivery.mode = merge` 면 세션 완료 후 `main` 에 머지+푸시, `pr` 이면 드래프트 PR 을 생성한다.
- FR-4.3 세션 비정상 종료 시에도 uncommitted 변경을 자동 커밋(safety-net)하여 유실을 방지한다.
- FR-4.4 `scripts/harness/gc.sh` 로 30일 이상 된 오래된 worktree 를 주간 GC 한다.

### FR-5. 에이전트 세션 플러그인
- FR-5.1 `AgentSession` 인터페이스(`start / execute / cancel / kill / isAlive / on / off / dispose`) 를 구현하는 모든 모듈은 `SessionFactory.registerSession` 으로 등록 가능하다.
- FR-5.2 내장 구현: Claude(stateless, per-execute spawn), Codex(persistent JSON-RPC), Gemini(ACP persistent + one-shot fallback).
- FR-5.3 `agent.type` 은 라우팅 우선순위로 결정된다: `model:*` 레이블 → `score:N` → `config.agentType`(기본값).
- FR-5.4 타임아웃(기본 3600s) 초과 시 SIGTERM → 5s 후 SIGKILL.

### FR-6. 재시도 큐
- FR-6.1 지수 백오프: `60s × 2^(attempt-1)`, 최대 3회.
- FR-6.2 워크스페이스 생성 실패, 상태 전이 실패, 세션 실패 모두 동일 큐로 진입한다.
- FR-6.3 최대 재시도 초과 시 에러 코멘트 + Cancelled 상태로 전이한다.
- FR-6.4 프로세스 재시작 시 In Progress 이슈를 Linear 로부터 재조회해 재시도 큐를 복구한다(startup sync).

### FR-7. CLI (`av`)
- FR-7.1 `av setup` 은 `~/.config/agent-valley/settings.yaml` 와 `valley.yaml` 을 대화형으로 생성한다.
- FR-7.2 `av up / down` 은 대시보드 + ngrok 을 백그라운드 데몬으로 관리하고 `.av.pid` 에 상태를 기록한다.
- FR-7.3 `av dev` 는 포그라운드 실행 + `valley.yaml` 파일 변경 감지 시 자동 재시작.
- FR-7.4 `av status` 는 `/api/status` 를 조회해 JSON 스냅샷을 출력한다.
- FR-7.5 `av top` 은 2초 간격으로 활성 에이전트·대기 이슈·재시도 큐를 TUI 로 표시한다.
- FR-7.6 `av issue <desc>` 는 Claude CLI 로 설명을 확장해 Linear 이슈를 생성한다. `--raw/--parent/--blocked-by/--scope/--breakdown` 옵션 지원.
- FR-7.7 `av login/logout` 은 Supabase 세션을 관리하고, `av invite` 는 팀 합류용 config 를 클립보드에 복사한다.

### FR-8. 대시보드 API
- FR-8.1 `POST /api/webhook` — Linear 웹훅 수신.
- FR-8.2 `GET /api/status` — `activeWorkspaces / waitingIssues / retryQueueSize / config` 스냅샷.
- FR-8.3 `GET /api/events` — SSE 스트림 (`agent.start/done/failed`).
- FR-8.4 `GET /api/health` — 오케스트레이터 초기화 여부. 미초기화 시 503.
- FR-8.5 대시보드 UI 는 PixiJS 로 오피스 씬(책상 = `MAX_PARALLEL`, 캐릭터 = 에이전트)을 렌더링하고 실시간 업데이트한다.

### FR-9. 팀 대시보드 (옵션)
- FR-9.1 Supabase 인증 + ledger 이벤트 삽입(`node.join/reconnect/leave`, `agent.start/done/failed/cancelled`).
- FR-9.2 RLS 로 본인 소속 팀만 이벤트를 읽을 수 있다.
- FR-9.3 노드 재연결 시 `lastSeq` 기반으로 누락 이벤트를 리플레이한다.

### FR-10. 설정
- FR-10.1 `settings.yaml`(글로벌, 사용자 자격) + `valley.yaml`(프로젝트, 팀/워크스페이스/라우팅) 머지. 프로젝트가 글로벌을 덮어쓴다.
- FR-10.2 Zod 스키마 검증 실패 시 누락된 키 경로와 수정 대상 파일을 포함하는 에러 메시지를 출력한다.
- FR-10.3 프롬프트 템플릿 변수: `{{issue.identifier}} / {{issue.title}} / {{issue.description}} / {{workspace_path}} / {{attempt.id}} / {{retry_count}} / {{retry_reason}}`.

---

## 9. 비기능 요구사항 (Non-Functional)

| 범주 | 요구사항 |
|---|---|
| 보안 | HMAC-SHA256 서명 검증 필수. 시크릿은 `settings.yaml / valley.yaml`(gitignore)에만 존재. 프롬프트 주입 방어: `valley.yaml` prompt 는 trusted, 이슈 본문은 untrusted. 외부 네트워크 호출은 승인된 어댑터만 경유. Linear API 요청은 30s 타임아웃. |
| 성능 | 웹훅 수신 → 에이전트 spawn 까지 p95 ≤ 2s. `av top` 렌더 주기 2s ± 200ms. 세션 spawn/kill 오버헤드 ≤ 1s. |
| 신뢰성 | SIGTERM/SIGINT 수신 시 graceful shutdown — 실행 중 세션 모두 cancel. Hot reload 시 이전 오케스트레이터 인스턴스 정지 후 새 인스턴스 기동. Startup sync 로 오프라인 중 누락 이벤트 복구. |
| 관측성 | 모든 에이전트 액션은 구조화 JSON 로그로 기록. 팀 모드에서는 ledger 이벤트로 브로드캐스트. |
| 확장성 | SessionFactory 로 커스텀 에이전트 추가 가능. Tracker/Workspace 포트 도입 시 어댑터 교체만으로 다른 tracker/FS 백엔드 지원. |
| 이식성 | macOS/Linux 지원. Bun 1.x / Node 22+. ngrok 없으면 WARN 후 계속(로컬 한정). |
| 유지보수성 | 파일당 최대 500줄. 레이어 위반/시크릿/금지 패턴은 `validate.sh` 로 차단. Biome 린트 + Vitest 테스트. 테스트 수 ≈ 283. |
| 접근성 | 대시보드는 WCAG AA 컨트라스트. CLI 출력은 컬러 이탈 시에도 가독성 유지(picocolors 사용). |

---

## 10. 릴리스 계획

### v0.1 (2026-04 초)
- Linear 단일 tracker, Claude/Codex/Gemini 3 에이전트, 재시도 큐, DAG 스케줄러, 멀티 레포 라우팅, 스코어 기반 라우팅, 팀 대시보드 베타.

### v0.2 (릴리스됨, 2026-04)
PR 단위 기준:
- **PR0**: Characterization 테스트 50건으로 기존 동작 잠금.
- **PR1**: `IssueTracker / WebhookReceiver / WorkspaceGateway` 도메인 포트 + DI seam + Linear 어댑터 + contract 스위트.
- **PR2**: WorkspaceManager 분할 (`worktree-lifecycle` / `delivery-strategy` / `safety-net`).
- **PR3**: Orchestrator 분할 (`OrchestratorCore` / `IssueLifecycle` / `WebhookRouter` / facade).
- **PR4**: `AgentRunnerPort` 도입, `ParsedWebhookEvent` 도메인 승격.
- **Feature A**: GitHub 어댑터 + `POST /api/webhook/github` + contract 통과.
- **Feature B**: `BudgetService` — 이슈당 / 일별 토큰·비용 한도.
- **Feature C**: 라이브 인터벤션 — `InterventionBus` + `POST /api/intervention` + `InterventionPanel` UI.
- **Feature D**: 관측성 — OpenTelemetry OTLP HTTP 트레이스 + Prometheus `/api/metrics` (둘 다 기본 off).
- **M3**: 통합 테스트 3종 (`todo-to-done` / `retry-exhaust` / `intervention-flow`) + 문서 업데이트.

전체 테스트 723개 / `validate.sh` green / 500줄 grandfather 목록 최소화.

### v0.3+ (구상)
- 인터벤션 원격 접근 (서명 세션 토큰).
- 레코딩 세션(디터미니스틱 재현) 및 평가 루프.
- 팀 대시보드 대용량 이벤트 아카이빙 / 파티셔닝.
- Jira 어댑터.

---

## 11. 리스크 및 대응

| 리스크 | 영향 | 대응 |
|---|---|---|
| Linear API 변경 | 이슈 fetch/전이 실패 | 어댑터 계층 분리(v0.2 PR1), 계약 테스트 보강 |
| 에이전트 폭주(토큰 과다 소모) | 비용 급증 | `MAX_PARALLEL` 한도 + 타임아웃 + 재시도 상한 |
| 워크스페이스 리소스 누수 | 디스크 포화 | 주간 GC + 세션 종료 훅 |
| 웹훅 서명 키 유출 | 위조 이벤트 주입 | secret gitignore + pre-commit 검사, 서명 검증 필수 |
| 프롬프트 주입으로 민감 명령 실행 | 파일 유출·임의 커밋 | 이슈 본문 sanitize, 워크스페이스 격리, SAFETY.md 준수 |
| 공급업체 종속(Claude/Codex/Gemini 프로토콜 변경) | 세션 장애 | SessionFactory 플러그인 계층으로 격리, 각 세션별 기능 감지 |

---

## 12. 오픈 이슈 / 결정 필요 (TBD)
- T1. Linear 외 tracker 1순위: GitHub Issues vs Jira? (현재 설계는 GitHub 쪽을 암시)
- T2. 스코어 기반 라우팅이 웹훅 진입 경로에서 비블로킹 분석으로 돌아갈 때, 초기 라벨이 없는 이슈를 어떤 기본 모델로 태울지 (`defaultAgentType` 그대로 유지할지 보수적 모델로 낮출지).
- T3. 팀 대시보드 ledger 테이블 파티셔닝 기준(팀 ID vs 시간) — 대용량 시나리오에서 결정 필요.
- T4. `delivery.mode=pr` 에서 PR 리뷰어 자동 지정 여부(Linear 어사이니 기반).

---

## 13. 용어집
- **Symphony:** 7-컴포넌트로 구성된 에이전트 오케스트레이션 레퍼런스 아키텍처.
- **Worktree:** 이슈별로 격리된 git working tree. `WORKSPACE_ROOT/{issue-key}` 경로.
- **AgentSession:** 에이전트 프로세스 생명주기를 추상화한 인터페이스. Claude/Codex/Gemini 각자 구현.
- **DAG 스케줄러:** `blocked_by` 관계를 그래프로 해석해 실행 가능한 이슈만 디스패치.
- **Ledger:** 팀 대시보드 이벤트 소싱 저장소(Supabase).
- **MAX_PARALLEL:** 동시에 실행 가능한 에이전트 최대 수. 기본값 하드웨어 기반 자동 산출.
