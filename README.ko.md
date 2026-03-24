# Agent Valley

Linear 웹훅 기반 에이전트 오케스트레이션 플랫폼. Linear에 이슈를 등록하면 AI 에이전트(Claude, Codex, Gemini)가 격리된 git worktree에서 자동으로 개발을 수행합니다 — 병렬로.

> Read in: [English](./README.md)

```
Linear Issue (Todo)
  → Webhook → Orchestrator → Git Worktree → Agent Session
  → Completion → Merge/PR → Done
```

**핵심 원칙:** Agent Valley는 스케줄러/러너입니다. 생명주기 상태 전환(Todo → In Progress → Done/Cancelled)을 관리하고 작업 요약을 게시합니다. 에이전트는 비즈니스 로직(코드 작성, PR 생성)에 집중합니다.

**TypeScript + Bun**으로 구축되었습니다. AgentSession 플러그인 시스템을 통해 **Claude Code, Codex, Gemini CLI**를 기본 지원하며 — 단일 인터페이스를 구현하여 커스텀 에이전트를 추가할 수 있습니다.

---

## 작동 방식

1. Linear에서 이슈를 생성합니다 (또는 `bun av issue "description"`)
2. Linear이 대시보드로 웹훅을 전송합니다
3. Orchestrator가 HMAC 서명을 검증하고 이슈를 In Progress로 전환합니다
4. DAG 스케줄러가 의존성을 확인합니다 — 차단된 이슈는 차단 이슈가 완료될 때까지 대기합니다
5. WorkspaceManager가 `WORKSPACE_ROOT`에 격리된 git worktree를 생성합니다
6. AgentRunnerService가 에이전트(Claude / Codex / Gemini)를 실행합니다
7. 완료 시: main에 자동 병합(또는 PR 생성), Linear에 요약 게시, Done으로 전환
8. 실패 시: 지수 백오프 재시도(60s × 2^n, 최대 3회), 이후 에러 코멘트와 함께 취소
9. 슬롯 보충: 완료된 에이전트가 용량을 반환하면 대기 중인 다음 이슈가 자동으로 시작됩니다

`MAX_PARALLEL`(하드웨어에서 자동 감지)까지 여러 이슈가 병렬로 실행됩니다.

---

## 빠른 시작

```bash
# 클론
git clone https://github.com/first-fluke/agent-valley.git
cd agent-valley
bun install

# 대화형 설정 마법사
bun av setup

# 또는 수동 설정
cp .env.example .env
# Linear API 키, workflow state UUID, WORKSPACE_ROOT를 입력하세요

# 시작 (dashboard + orchestrator + ngrok 터널)
bun av dev
```

콘솔에 출력된 ngrok URL을 Linear 웹훅 설정에 복사합니다 → `{url}/api/webhook`.

---

## CLI

```bash
bun av setup              # 대화형 설정 마법사
bun av dev                # 포그라운드로 시작 (파일 감시 + 자동 재시작)
bun av up                 # 백그라운드 데몬으로 시작
bun av down               # 백그라운드 데몬 중지
bun av status             # Orchestrator 상태 조회
bun av top                # 실시간 에이전트 상태 모니터
bun av logs               # 대시보드 로그 조회 (-n으로 라인 수 지정)
bun av login              # 팀 로그인 (Supabase 인증)
bun av logout             # 팀 로그아웃
bun av invite             # 팀 설정을 클립보드에 복사
```

### 이슈 생성

```bash
bun av issue "fix auth bug"                        # 이슈 생성 (Claude가 설명을 확장)
bun av issue "fix auth bug" --raw                  # 확장 없이 생성
bun av issue "fix auth bug" --yes                  # 확인 건너뛰기
bun av issue "add tests" --parent ACR-10           # 하위 이슈로 생성
bun av issue "migrate db" --blocked-by ACR-5       # 의존성 설정
bun av issue "refactor auth" --breakdown           # 하위 작업으로 자동 분해
```

---

## 설정

### 필수 (.env)

| 변수 | 설명 |
|---|---|
| `LINEAR_API_KEY` | Linear Personal API 키 (Settings → API) |
| `LINEAR_TEAM_ID` | 팀 식별자 (예: `ACR`) |
| `LINEAR_TEAM_UUID` | 팀 UUID (GraphQL 쿼리용) |
| `LINEAR_WEBHOOK_SECRET` | 웹훅 서명 시크릿 |
| `LINEAR_WORKFLOW_STATE_TODO` | "Todo" 상태 UUID |
| `LINEAR_WORKFLOW_STATE_IN_PROGRESS` | "In Progress" 상태 UUID |
| `LINEAR_WORKFLOW_STATE_DONE` | "Done" 상태 UUID |
| `LINEAR_WORKFLOW_STATE_CANCELLED` | "Cancelled" 상태 UUID |
| `WORKSPACE_ROOT` | 대상 git 저장소의 절대 경로 |

**Linear UUID 확인 방법:**

```bash
# 팀 목록
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq .

# 워크플로우 상태 목록
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ workflowStates { nodes { id name type } } }"}' | jq .
```

### 선택 사항

| 변수 | 기본값 | 설명 |
|---|---|---|
| `AGENT_TYPE` | `claude` | 기본 에이전트: `claude` / `codex` / `gemini` |
| `MAX_PARALLEL` | auto | 최대 동시 에이전트 수 (CPU에서 자동 감지) |
| `DELIVERY_MODE` | `merge` | `merge` (자동 병합+푸시) 또는 `pr` (draft PR 생성) |
| `SERVER_PORT` | `9741` | 대시보드 HTTP 포트 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_FORMAT` | `json` | `json` / `text` |

### 멀티 저장소 라우팅 (선택 사항)

Linear 라벨을 기반으로 이슈를 다른 저장소로 라우팅합니다. 첫 번째 일치하는 라벨이 적용되며, 일치하지 않으면 `WORKSPACE_ROOT`로 폴백합니다:

```bash
ROUTING_RULES='[{"label":"backend","workspaceRoot":"/path/to/backend"},{"label":"frontend","workspaceRoot":"/path/to/frontend","agentType":"codex","deliveryMode":"pr"}]'
```

### 점수 기반 라우팅 (선택 사항)

이슈 난이도를 자동 평가하여 다른 에이전트로 라우팅합니다:

```bash
SCORING_MODEL=haiku
SCORE_ROUTING='{"easy":{"min":1,"max":3,"agent":"gemini"},"medium":{"min":4,"max":7,"agent":"codex"},"hard":{"min":8,"max":10,"agent":"claude"}}'
```

### 팀 대시보드 (선택 사항)

Supabase 실시간 기반 멀티 노드 대시보드:

```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=your-anon-key
TEAM_ID=my-team
DISPLAY_NAME=my-node
```

---

## WORKFLOW.md

에이전트에게 전송되는 프롬프트 템플릿입니다. YAML front matter로 설정을 정의하고(문서 용도), 본문에는 템플릿 변수가 포함된 프롬프트가 들어갑니다:

```yaml
---
tracker:
  type: linear
workspace:
  root: $WORKSPACE_ROOT
agent:
  type: $AGENT_TYPE
  timeout_seconds: 3600
---

You are a software engineer working on issue {{issue.identifier}}: {{issue.title}}

## Issue Details
{{issue.description}}

## Workspace
- Path: {{workspace_path}}
- Attempt: {{attempt.id}} (retry count: {{retry_count}})

## Instructions
1. Read AGENTS.md for project conventions
2. Implement the changes described in the issue
3. Write tests
4. Commit your changes with a clear message
```

**템플릿 변수:** `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}`, `{{attempt.id}}`, `{{retry_count}}`, `$VAR` (환경 변수 치환)

---

## 아키텍처

### 모노레포 구조

```
agent-valley/
├── apps/
│   ├── cli/                  @agent-valley/cli — Commander CLI (bun av)
│   └── dashboard/            agent-valley-dashboard — Next.js 16 + PixiJS
├── packages/
│   └── core/                 @agent-valley/core — 오케스트레이션 엔진
│       └── src/
│           ├── config/         Zod 설정 검증 + WORKFLOW.md 파서
│           ├── domain/         순수 타입: Issue, Workspace, RunAttempt, DAG
│           ├── orchestrator/   상태 머신, 에이전트 러너, 재시도 큐, DAG 스케줄러
│           ├── sessions/       에이전트 플러그인: Claude, Codex, Gemini
│           ├── tracker/        Linear GraphQL 클라이언트 + 웹훅 HMAC 검증
│           ├── workspace/      Git worktree 생명주기 + 병합/PR
│           └── observability/  구조화된 JSON/텍스트 로거
├── docs/
│   ├── architecture/         LAYERS.md, CONSTRAINTS.md, enforcement/
│   ├── specs/                Symphony 7개 컴포넌트 인터페이스 스펙
│   ├── stacks/               TypeScript, Python, Go 가이드
│   └── harness/              SAFETY.md, LEGIBILITY.md, ENTROPY.md, FEEDBACK-LOOPS.md
├── scripts/
│   ├── dev.sh                개발 환경 부트스트랩
│   ├── install.sh            하네스 설치 (신규 + 기존 프로젝트)
│   └── harness/
│       ├── validate.sh       아키텍처 검증 (시크릿, 레이어 위반)
│       └── gc.sh             Worktree 가비지 컬렉터
├── AGENTS.md                 에이전트 지침 (공유 진입점)
├── CLAUDE.md                 Claude Code 프로젝트 지침
├── WORKFLOW.md               에이전트 프롬프트 템플릿
└── .env.example              환경 변수 참조
```

### 클린 아키텍처 레이어

```
Presentation   대시보드 라우트 핸들러 (비즈니스 로직 없음)
     ↓
Application    Orchestrator, AgentRunnerService (인터페이스를 통한 조정)
     ↓
Domain         Issue, Workspace, RunAttempt, DAG (순수 타입, 외부 의존성 없음)
     ↓
Infrastructure Linear 클라이언트, git 작업, 에이전트 세션 (어댑터)
```

의존성 화살표는 **아래 방향으로만** 향합니다. `docs/architecture/LAYERS.md`를 참고하세요.

### Symphony 7개 컴포넌트

| # | 컴포넌트 | 역할 | 스펙 |
|---|---|---|---|
| 1 | **Workflow Loader** | `WORKFLOW.md` 파싱 — YAML front matter + 프롬프트 본문 | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | 타입 기반 설정 (Zod) + `$VAR` 환경 변수 해석 | `docs/specs/config-layer.md` |
| 3 | **Tracker Client** | Linear GraphQL — 이슈 조회, 상태 전환, 코멘트, HMAC 검증 | `docs/specs/tracker-client.md` |
| 4 | **Orchestrator** | 웹훅 이벤트 핸들러, 상태 머신, 재시도 큐, DAG 스케줄러 | `docs/specs/orchestrator.md` |
| 5 | **Workspace Manager** | 이슈별 git worktree 생성, 병합/PR, 정리 | `docs/specs/workspace-manager.md` |
| 6 | **Agent Runner** | AgentSession 추상화, 타임아웃 강제, 병렬 실행 | `docs/specs/agent-runner.md` |
| 7 | **Observability** | 구조화된 JSON 로그, 시스템 메트릭, SSE 상태 표면 | `docs/specs/observability.md` |

### Agent Session 플러그인

| 에이전트 | 프로토콜 | 모드 |
|---|---|---|
| **Claude** | NDJSON 스트리밍 (`claude --print --output-format stream-json`) | Stateless — 실행마다 새 프로세스 |
| **Codex** | JSON-RPC 2.0 over stdio (`codex app-server --listen stdio://`) | Persistent 연결 |
| **Gemini** | ACP persistent / one-shot JSON 폴백 | 기능 감지를 통한 듀얼 모드 |

`SessionFactory.registerSession()`을 통해 확장 가능 — `AgentSession` 인터페이스를 구현하여 커스텀 에이전트를 추가하세요.

---

## 대시보드

실시간 에이전트 상태를 보여주는 PixiJS 렌더링 오피스 장면:

- **에이전트 캐릭터** — 이슈 식별자 말풍선이 있는 책상의 에이전트
- **오피스 시각화** — 책상이 `MAX_PARALLEL`에 맞게 조정, 커피 머신, 서버 랙 등
- **시스템 메트릭** — CPU, 메모리, 가동 시간
- **SSE 실시간 이벤트** — agent.start, agent.done, agent.failed 즉시 업데이트
- **팀 HUD** — 멀티 노드 뷰 (Supabase 설정 필요)

### API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/webhook` | POST | Linear 웹훅 수신기 (HMAC-SHA256 검증) |
| `/api/events` | GET | 실시간 대시보드 업데이트를 위한 SSE 스트림 |
| `/api/status` | GET | Orchestrator 상태 JSON 스냅샷 |
| `/api/health` | GET | 헬스 체크 (Orchestrator 미초기화 시 503) |

---

## 주요 기능

### DAG 의존성 스케줄링

`blocked_by` 관계가 있는 이슈는 모든 차단 이슈가 완료될 때까지 대기합니다. 차단 이슈가 완료되면 DAG 스케줄러가 연쇄적으로 차단 해제된 이슈를 디스패치합니다. 순환 참조는 감지되어 무시됩니다.

### 재시도 큐

실패한 에이전트 실행은 지수 백오프로 재시도됩니다 (`60s × 2^(attempt-1)`, 최대 3회). 워크스페이스 생성 실패와 상태 전환 실패도 재시도됩니다. 최대 재시도 횟수 초과 시 → 에러 코멘트와 함께 이슈가 취소됩니다.

### 안전망

- 커밋되지 않은 에이전트 작업을 감지하여 전달 전에 자동 커밋
- PR 모드에서 안전망 draft PR 생성
- SIGTERM/SIGINT 시 우아한 종료 — 실행 중인 모든 에이전트 중지
- 핫 리로드 정리 — 새 Orchestrator 인스턴스 시작 전에 이전 인스턴스 중지

### 시작 동기화

부팅 시 Orchestrator가 Linear에서 모든 Todo + In Progress 이슈를 가져와 DAG 캐시를 재조정합니다. 기존 진행 중인 이슈는 자동으로 재개됩니다.

---

## 개발

```bash
bun test                        # 테스트 실행 (vitest, 283개 테스트)
bun run lint                    # 린트 (biome)
bun run lint:fix                # 린트 이슈 자동 수정
./scripts/harness/validate.sh   # 아키텍처 검증
./scripts/dev.sh                # 개발 환경 부트스트랩
./scripts/harness/gc.sh         # 오래된 worktree 가비지 컬렉션
```

### 기존 프로젝트에 하네스 설치

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
```

### CI/CD

| 워크플로우 | 트리거 | 목적 |
|---|---|---|
| `ci.yml` | main에 Push/PR | `validate.sh` + 테스트 |
| `harness-gc.yml` | 매주 (일요일 00:00 UTC) | 오래된 worktree 정리 |

---

## 보안

- **HMAC-SHA256** 웹훅 서명 검증으로 모든 수신 Linear 이벤트 확인
- **프롬프트 인젝션 방어** — `WORKFLOW.md`는 신뢰됨, 이슈 본문은 항상 진입점에서 살균
- **최소 권한** — 에이전트는 할당된 worktree 내에서만 작동
- **시크릿 관리** — 모든 시크릿은 `.env`에만 저장 (gitignore 처리), pre-commit 시크릿 탐지
- **Fetch 타임아웃** — 모든 Linear API 호출에 30초 타임아웃
- **감사 로깅** — 모든 에이전트 작업을 구조화된 JSON으로 기록

전체 문서: `docs/harness/SAFETY.md`

---

## 아키텍처 제약 사항

| # | 규칙 | 근거 |
|---|---|---|
| 1 | Domain 레이어에 프레임워크 import 금지 | Domain은 순수하고 테스트 가능하게 유지 |
| 2 | 라우터에 비즈니스 로직 금지 | Presentation은 Application에 위임 |
| 3 | 하드코딩된 시크릿 금지 | `.env`만 사용 |
| 4 | 이슈 본문은 신뢰할 수 없음 | 경계에서 살균 |
| 5 | 파일당 최대 500줄 | 가독성 |
| 6 | Orchestrator 외부에서 공유 가변 상태 금지 | 단일 상태 권한 |
| 7 | 에러 메시지에 수정 지침 포함 필수 | 에이전트가 에러에서 자가 교정 |

예제가 포함된 전체 목록: `docs/architecture/CONSTRAINTS.md`

---

## AI 에이전트를 위한 안내

이 저장소를 읽고 있는 AI 에이전트라면, 자세한 설정 지침, 규칙, 구현 가이드는 **[AGENTS.md](./AGENTS.md)**를 참고하세요.

Claude Code 하위 에이전트는 `.claude/agents/`에서 사용 가능합니다:
- `symphony-architect.md` — 아키텍처 결정, SPEC 해석
- `symphony-implementer.md` — 프리플라이트 체크를 포함한 기능 구현
- `symphony-reviewer.md` — PR 템플릿 프레임워크를 활용한 코드 리뷰

---

## 메트릭

| 메트릭 | 설명 |
|---|---|
| **Time to PR** | 이슈 할당 → PR 생성 |
| **CI pass rate** | 첫 실행에서 CI를 통과한 PR 비율 |
| **Review time per PR** | PR당 평균 사람 리뷰어 소요 시간 |
| **Doc freshness** | `AGENTS.md` 마지막 업데이트 이후 일수 (30일 초과 시 경고) |

---

## 라이선스

[AGPL-3.0](LICENSE)
