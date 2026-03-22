# Symphony Dev Template

**[OpenAI Symphony SPEC](https://github.com/openai/symphony/blob/main/SPEC.md) 기반의 AI 코딩 에이전트 오케스트레이션을 위한 기술스택 무관 개발 하네스 템플릿.**

> Read in: [English](./README.md)

---

## 이게 뭔가요?

이 레포지토리는 AI 코딩 에이전트(Claude Code, Codex, Gemini, Antigravity 등)를 팀 규모로 소프트웨어 엔지니어링 작업에 투입하고 싶은 팀을 위한 **즉시 사용 가능한 프로젝트 템플릿**입니다.

OpenAI의 [Harness Engineering](https://openai.com/index/harness-engineering/) 접근법에서 영감을 받았습니다. 3명의 엔지니어, 5개월, 약 100만 줄의 코드, 수동으로 작성한 코드 0줄, 엔지니어 1인당 하루 평균 3.5개의 PR. 이 템플릿은 그 워크플로우를 재현하기 위한 스캐폴딩을 제공합니다.

템플릿은 **기술스택 무관**입니다. 아키텍처 원칙, 문서, CI, 에이전트 하네스가 모두 갖춰져 있습니다. 구현 언어(TypeScript, Python, Go)는 여러분이 선택하고, 준비가 되면 `src/`를 채우면 됩니다.

---

## 핵심 동작 개념

```
Linear 이슈 (Todo 상태)
        │
        ▼
  Orchestrator  ──webhook──▶  Linear Webhook Events
        │
        ├─ Todo → In Progress (Orchestrator가 Linear API로 전환)
        │
        ▼  (이슈별로)
  WorkspaceManager  ──생성──▶  git worktree  {WORKSPACE_ROOT}/{이슈-키}/
        │
        ▼
  AgentRunner  ──스폰──▶  AgentSession (claude/gemini/codex)  (WORKFLOW.md 프롬프트 렌더링 결과)
        │
        ▼
  에이전트가 격리된 worktree에서 작업, 커밋, PR 오픈
        │
        ▼
  Orchestrator가 작업 요약 코멘트 → Done 전환
        │
        ▼
  CI 통과  →  사람이 아키텍처만 리뷰  →  병합  →  worktree GC
```

**핵심 원칙:** Symphony는 스케줄러/러너입니다. 라이프사이클 상태 전환(Todo→InProgress→Done/Cancelled)을 관리하고, 에이전트는 비즈니스 로직(코드 작성, PR 생성)에 집중합니다.

---

## 레포지토리 구조

```
agent-template/
│
├── AGENTS.md                        ← 모든 에이전트 공통 진입점 (반드시 먼저 읽을 것)
├── CLAUDE.md                        ← Claude Code 전용 thin wrapper (AGENTS.md 임포트)
├── WORKFLOW.md                      ← Symphony 계약: YAML 설정 + 에이전트 프롬프트 템플릿
├── .env.example                     ← 환경변수 템플릿 (.env로 복사 후 사용)
│
├── docs/
│   ├── specs/                       ← Symphony 7개 컴포넌트 인터페이스 명세
│   │   ├── domain-models.md         ← Issue, Workspace, RunAttempt, LiveSession 등
│   │   ├── workflow-loader.md       ← WORKFLOW.md 파싱 명세
│   │   ├── config-layer.md          ← 타입된 설정 + $VAR resolution
│   │   ├── tracker-client.md        ← Linear GraphQL 어댑터 명세
│   │   ├── orchestrator.md          ← Webhook 이벤트 핸들러, 상태 머신, 재시도 큐
│   │   ├── workspace-manager.md     ← 이슈별 worktree 수명주기
│   │   ├── agent-runner.md          ← AgentSession 추상화, SPEC §17 테스트 매트릭스
│   │   └── observability.md         ← 구조화된 로그, 측정 지표, 선택적 OTEL
│   │
│   ├── architecture/
│   │   ├── LAYERS.md                ← 의존성 방향 원칙 (언어 무관)
│   │   ├── CONSTRAINTS.md           ← 금지 패턴 7가지 (코드 예시 포함)
│   │   └── enforcement/
│   │       ├── typescript.md        ← dependency-cruiser 설정
│   │       ├── python.md            ← import-linter 설정
│   │       └── go.md                ← golangci-lint 설정
│   │
│   ├── stacks/                      ← 스택별 착수 가이드
│   │   ├── typescript.md            ← Node.js 20+, Express/Hono, Zod, Jest
│   │   ├── python.md                ← Python 3.12+, FastAPI, Pydantic v2, uv
│   │   └── go.md                    ← Go 1.22+, Echo, sqlx, testify
│   │
│   └── harness/
│       ├── LEGIBILITY.md            ← worktree 격리, Chrome DevTools Protocol
│       ├── FEEDBACK-LOOPS.md        ← 정적/동적 컨텍스트, 피드백 루프
│       ├── ENTROPY.md               ← AI Slop 방지, GC 패턴, 성숙도 레벨
│       └── SAFETY.md                ← 최소 권한, 프롬프트 인젝션 방어, 감사 로그
│
├── src/                             ← 비어있음 — 스택 선택 후 채울 것
│
├── scripts/
│   ├── dev.sh                       ← 원커맨드 개발 환경 부팅
│   └── harness/
│       ├── gc.sh                    ← 오래된 worktree 가비지 컬렉션
│       └── validate.sh              ← 아키텍처 제약 검증
│
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                   ← 린트 + 아키텍처 검사 + 테스트
│   │   └── harness-gc.yml           ← 주 1회 엔트로피 GC (크론)
│   ├── PULL_REQUEST_TEMPLATE.md     ← AI 인식 PR 체크리스트
│   └── .pre-commit-config.yaml      ← 로컬 사전커밋훅
│
├── .agents/
│   ├── skills/
│   │   ├── symphony-scaffold/       ← 새 Symphony 구현 스캐폴딩
│   │   ├── symphony-component/      ← Symphony 컴포넌트 단일 구현
│   │   ├── symphony-conformance/    ← SPEC 준수 감사
│   │   ├── harness-gc/              ← worktree 가비지 컬렉션 가이드
│   │   ├── backend-agent/           ← 스택 무관 API 백엔드 (TS/Python/Go)
│   │   ├── frontend-agent/          ← React/Next.js 프론트엔드
│   │   └── ...                      ← 기타 oh-my-agent 스킬들
│   └── workflows/
│       └── ultrawork/               ← Phase-gated 다중 Wave 오케스트레이션
│
└── .claude/
    ├── agents/
    │   ├── symphony-architect.md    ← 아키텍처 결정 서브에이전트
    │   ├── symphony-implementer.md  ← 기능 구현 서브에이전트
    │   └── symphony-reviewer.md     ← 코드 리뷰 서브에이전트
    └── skills/                      ← .agents/skills/ 심링크
```

---

## 설치

Agent Valley는 **신규 프로젝트** (전체 스캐폴드)와 **기존 프로젝트** (하네스만 추가) 모두 지원합니다. 설치 스크립트가 자동으로 모드를 감지합니다.

### 신규 프로젝트

레포를 클론해서 그대로 프로젝트 베이스로 사용합니다:

```bash
git clone https://github.com/first-fluke/agent-valley.git my-project
cd my-project

# agent-valley git 히스토리 제거 후 내 프로젝트로 시작
rm -rf .git
git init
git add -A
git commit -m "chore: init from agent-valley"

# 환경 설정
cp .env.example .env
# .env 편집 (LINEAR_API_KEY, WORKSPACE_ROOT 등)

# 검증
./scripts/harness/validate.sh
```

모든 파일이 이미 준비되어 있습니다 — `src/`는 비어 있고 구현을 시작할 수 있습니다. 신규 클론에서는 `install.sh`를 실행할 필요가 없습니다.

### 기존 프로젝트

프로젝트 루트에서 설치 스크립트를 바로 실행합니다 — 클론 불필요:

```bash
cd your-existing-project
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
```

**기존 프로젝트에 설치되는 항목:**

| 항목 | 처리 방식 |
|---|---|
| `.agents/`, `.claude/`, `docs/` | 복사 (하네스 코어) |
| `scripts/harness/gc.sh`, `validate.sh` | 복사 |
| `WORKFLOW.md`, `.env.example` | 복사 |
| `AGENTS.md` | 기존 파일 있으면 Symphony 섹션 추가, 없으면 생성 |
| `CLAUDE.md` | `@AGENTS.md` import 라인 없으면 추가 |
| `.gitignore` | 누락 항목만 추가 (덮어쓰기 없음) |
| `src/`, `scripts/dev.sh` | **스킵** |
| `.github/` | **선택적** — 설치 중 묻고 결정 |

### 설치 후 설정

**1. `.env` 설정**

```bash
cp .env.example .env
# .env 파일에 실제 값을 입력하세요
```

필수 값:

```bash
LINEAR_API_KEY=lin_api_YOUR_KEY_HERE
LINEAR_TEAM_ID=ACR
LINEAR_TEAM_UUID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_TODO=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_IN_PROGRESS=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_DONE=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
LINEAR_WORKFLOW_STATE_CANCELLED=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
WORKSPACE_ROOT=/절대경로/workspaces
LOG_LEVEL=info
```

**Linear UUID 찾는 방법:**

```bash
# 팀 UUID
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ teams { nodes { id key name } } }"}' | jq .

# 워크플로우 상태 UUID
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: YOUR_LINEAR_API_KEY" \
  -d '{"query":"{ workflowStates { nodes { id name type } } }"}' | jq .
```

> Linear Personal API Key 발급: Linear → Settings → API → Personal API keys

**2. 검증**

```bash
./scripts/harness/validate.sh
```

**3. Symphony 구현 스캐폴딩**

AI 에이전트에게 다음과 같이 요청하세요:

```
AGENT_SETUP.md를 읽고 [TypeScript/Python/Go]로 Symphony 구현을 스캐폴딩해줘.
```

또는 Claude Code 내장 스킬을 직접 사용:

```
/symphony-scaffold
```

---

## Symphony 7개 컴포넌트

| # | 컴포넌트 | 역할 | 명세 |
|---|---|---|---|
| 1 | **Workflow Loader** | `WORKFLOW.md` 파싱 — YAML front matter + 프롬프트 바디 | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | 타입된 설정 객체 + `$VAR` 환경변수 resolution | `docs/specs/config-layer.md` |
| 3 | **Issue Tracker Client** | Linear GraphQL 어댑터 — 이슈 조회, 상태 전환, 코멘트 | `docs/specs/tracker-client.md` |
| 4 | **Orchestrator** | Webhook 이벤트 핸들러, 상태 머신, 재시도 큐, 단일 in-memory 상태 권한 | `docs/specs/orchestrator.md` |
| 5 | **Workspace Manager** | 이슈별 `git worktree` 생성, 수명주기 훅, GC | `docs/specs/workspace-manager.md` |
| 6 | **Agent Runner** | AgentSession 추상화로 에이전트(claude/gemini/codex) 스폰, 타임아웃 강제 | `docs/specs/agent-runner.md` |
| 7 | **Observability** | 구조화된 JSON 로그 (stdout), 선택적 HTTP status surface, OTEL | `docs/specs/observability.md` |

### 도메인 모델

모든 컴포넌트가 공유하는 핵심 모델 (`docs/specs/domain-models.md`):

| 모델 | 설명 |
|---|---|
| `Issue` | Linear 이슈 데이터 — 읽기 전용, Symphony는 이 값을 쓰지 않음 |
| `Workspace` | 이슈별 격리 작업 디렉터리 (`{WORKSPACE_ROOT}/{key}/`) |
| `RunAttempt` | 에이전트 실행 한 번의 기록 (시작, 종료, 종료코드, 출력) |
| `LiveSession` | 실행 중인 프로세스 하트비트 추적 (재시작 시 고아 프로세스 감지용) |
| `RetryEntry` | 실패한 이슈의 재시도 스케줄 (지수 백오프) |
| `OrchestratorRuntimeState` | Orchestrator가 단독으로 소유하는 in-memory 상태 |

**Workspace 키 파생 규칙:** `issue.identifier`에서 `[A-Za-z0-9._-]` 외 문자를 `_`로 대체.

---

## 아키텍처

### 클린 아키텍처 계층

```
Presentation   — CLI, HTTP 핸들러. 비즈니스 로직 없음.
    ↓
Application    — Orchestrator, WorkspaceManager. 인터페이스를 통해 조율.
    ↓
Domain         — Issue, Workspace, RunAttempt. 순수 규칙, 외부 의존성 없음.
    ↓
Infrastructure — LinearApiClient, FileSystem, Git, Logger. 어댑터만.
```

의존성 방향은 항상 **아래 방향**만 허용됩니다. `docs/architecture/LAYERS.md` 참조.

### 주요 금지 패턴

1. Domain 계층에 프레임워크/ORM import 금지
2. Router/Handler에 비즈니스 로직 금지
3. 하드코딩된 비밀값 금지 — `.env`만 사용
4. 이슈 본문은 신뢰 불가 — 프롬프트 삽입 전 sanitize 필수
5. 단일 파일 500줄 초과 금지
6. Orchestrator 외부에서 shared mutable 상태 금지
7. 수정 지침 없는 에러 메시지 금지

전체 목록 + 코드 예시: `docs/architecture/CONSTRAINTS.md`

### 자동화된 강제

```bash
./scripts/harness/validate.sh    # 커밋 전, CI에서 자동 실행
```

| 스택 | 도구 | 설정 |
|---|---|---|
| TypeScript | dependency-cruiser | `docs/architecture/enforcement/typescript.md` |
| Python | import-linter + Ruff | `docs/architecture/enforcement/python.md` |
| Go | golangci-lint + go vet | `docs/architecture/enforcement/go.md` |

---

## 스택별 착수 가이드 요약

### TypeScript

| 역할 | 선택 |
|---|---|
| 런타임 | Node.js 20+ |
| HTTP | Express 또는 Hono |
| 스키마 검증 | Zod |
| 테스트 | Jest + ts-jest |
| 아키텍처 린터 | dependency-cruiser |

전체 가이드: `docs/stacks/typescript.md`

### Python

| 역할 | 선택 |
|---|---|
| 런타임 | Python 3.12+ |
| HTTP | FastAPI |
| 설정 검증 | Pydantic v2 |
| 패키지 관리 | uv |
| 아키텍처 린터 | import-linter |

전체 가이드: `docs/stacks/python.md`

### Go

| 역할 | 선택 |
|---|---|
| 런타임 | Go 1.22+ |
| HTTP | net/http 또는 Echo |
| 설정 | godotenv |
| 테스트 | testify |
| 아키텍처 린터 | golangci-lint |

전체 가이드: `docs/stacks/go.md`

---

## WORKFLOW.md — Symphony 계약 파일

`WORKFLOW.md`는 오케스트레이터 설정과 에이전트 프롬프트 템플릿을 하나의 파일에 정의합니다.

```yaml
---
# YAML front matter: 오케스트레이터 설정
tracker:
  type: linear
  api_key: $LINEAR_API_KEY
  team_id: $LINEAR_TEAM_ID
  webhook_secret: $LINEAR_WEBHOOK_SECRET
  workflow_states:
    todo: $LINEAR_WORKFLOW_STATE_TODO
    in_progress: $LINEAR_WORKFLOW_STATE_IN_PROGRESS
    done: $LINEAR_WORKFLOW_STATE_DONE
    cancelled: $LINEAR_WORKFLOW_STATE_CANCELLED

workspace:
  root: $WORKSPACE_ROOT
  cleanup_after_days: 7

agent:
  type: "codex"  # or "claude", "gemini"
  timeout_seconds: 3600
  max_retries: 3
---

You are a software engineer working on issue {{issue.identifier}}: {{issue.title}}

## Issue Details
{{issue.description}}

## Workspace
- Path: {{workspace_path}}
- Attempt: {{attempt.id}} (retry count: {{retry_count}})

## Instructions
1. Read AGENTS.md for project conventions
...
```

**템플릿 변수:** `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}`, `{{attempt.id}}`, `{{retry_count}}`

---

## 하네스 엔지니어링 원칙

이 템플릿은 OpenAI Harness Engineering의 5가지 핵심 원칙을 구현합니다:

### 1. 컨텍스트 엔지니어링
`AGENTS.md`가 모든 에이전트의 단일 진실 공급원(정적 컨텍스트)입니다. 로그와 측정 지표가 동적 컨텍스트를 제공합니다. 에이전트는 작업 시작 전에 반드시 `AGENTS.md`를 읽습니다.

### 2. 아키텍처 제약
의존성 방향 린터가 모든 커밋과 CI에서 실행됩니다. 나쁜 패턴은 코드 리뷰가 아니라 기계적으로 차단됩니다. `docs/architecture/CONSTRAINTS.md` 참조.

### 3. 애플리케이션 가시성 (Application Legibility)
각 이슈는 격리된 `git worktree`를 받습니다. 에이전트들이 서로의 작업을 방해할 수 없습니다. 선택적 Chrome DevTools Protocol(CDP) 지원으로 브라우저 기반 작업도 가능합니다. `docs/harness/LEGIBILITY.md` 참조.

### 4. 엔트로피 관리
주 1회 GC 에이전트(`scripts/harness/gc.sh`, `.github/workflows/harness-gc.yml` 자동화)가 오래된 worktree와 브랜치를 정리합니다. "AI Slop"(중복 코드, 미사용 import)은 린터 규칙과 컨벤션으로 방지합니다. `docs/harness/ENTROPY.md` 참조.

### 5. 병합 철학
단기 생명주기 PR. CI 통과 = 병합 가능. 사람의 리뷰는 아키텍처 게이트키핑에만 집중합니다. `docs/harness/FEEDBACK-LOOPS.md` 참조.

---

## AI 에이전트 스킬

### 내장 Symphony 스킬

| 스킬 | 트리거 | 목적 |
|---|---|---|
| `symphony-scaffold` | "scaffold symphony for [스택]" | 선택한 스택으로 전체 프로젝트 세팅 |
| `symphony-component` | "implement [컴포넌트명]" | Symphony 컴포넌트 단일 구현 |
| `symphony-conformance` | "audit symphony" / "check conformance" | SPEC 준수 감사 보고서 |
| `harness-gc` | "run gc" / "clean worktrees" | 가이드된 worktree 가비지 컬렉션 |

### Claude Code 서브에이전트

| 에이전트 | 설명 |
|---|---|
| `symphony-architect` | 아키텍처 결정, SPEC 해석, 계층 경계 질문 |
| `symphony-implementer` | 사전 아키텍처 체크 후 기능 구현 |
| `symphony-reviewer` | PR 템플릿을 기반으로 한 코드 리뷰 |

### 기타 oh-my-agent 스킬

`backend-agent`, `frontend-agent`, `db-agent`, `debug-agent`, `qa-agent`, `pm-agent`, `commit`, `brainstorm` 등 — `_shared/` 프로토콜을 통해 모두 스택 무관으로 동작합니다.

---

## 보안

### 프롬프트 인젝션 방어
- `WORKFLOW.md`는 신뢰 (버전 관리됨, 엔지니어가 작성)
- 이슈 본문(`issue.description`)은 항상 비신뢰 — 프롬프트 삽입 전 진입점에서 sanitize
- 최대 8,000자 제한 + 금지 패턴 제거

### 최소 권한
- 각 에이전트는 할당된 worktree (`{WORKSPACE_ROOT}/{key}/`) 내에서만 동작
- `main`/`master`에 직접 push 불가 — PR만 허용
- force push 불가

### 비밀값 관리
- 모든 비밀값은 `.env`에만 저장 (gitignore 등록)
- `.env.example`에는 키 이름과 설명만, 실제 값 없음
- Pre-commit 훅이 실수로 커밋되는 비밀값 감지

### 감사 로그
모든 에이전트 액션을 구조화된 JSON 형식으로 기록. `docs/specs/observability.md`에 전체 이벤트 카탈로그.

전체 보안 문서: `docs/harness/SAFETY.md`

---

## 하네스 성숙도 레벨

| 레벨 | 대상 | 요구사항 |
|---|---|---|
| **Level 1** (기본) | 신규 프로젝트 | 6개 표준 섹션 포함 `AGENTS.md`, 사전커밋훅 (린트 + 기본 검사), 커버리지 임계값 포함 단위 테스트 |
| **Level 2** (팀) | 에이전트 팀 규모 | CI 아키텍처 제약 검증, AI 인식 PR 체크리스트, CI에서 의존성 계층 린터 자동화 |
| **Level 3** (프로덕션) | 엔터프라이즈 | 에이전트 행동 추적 커스텀 미들웨어, 전체 OpenTelemetry 스택, 자동화된 이상 감지 알림 |

이 템플릿은 **Level 2** 준비 상태로 제공됩니다.

---

## CI/CD

### `ci.yml` — 메인 CI

`main`에 push 및 PR 시 트리거.

1. **validate** — `./scripts/harness/validate.sh` 실행 (비밀값 감지, 위험 패턴, 아키텍처 계층 위반)
2. **test** — 스택별 테스트 러너 (스캐폴딩됨; 스택 선택 후 활성화)

### `harness-gc.yml` — 주 1회 GC

매주 일요일 00:00 UTC 실행 (수동 트리거도 가능).

`./scripts/harness/gc.sh`를 실행하여:
- 30일 이상 경과한 worktree/브랜치 제거 (`GC_DAYS`로 설정 가능)
- 소프트 삭제 우선 (`.gc-flagged` 마커), 다음 사이클에서 실제 삭제

### Pre-commit 훅

```bash
# 설치 (pre-commit 필요)
pip install pre-commit
pre-commit install
```

훅: 후행 공백, YAML/JSON 문법, 비밀값 감지 (`detect-secrets`), Ruff (Python), ESLint (TS), golangci-lint (Go), `validate.sh`.

---

## 측정 지표

| 지표 | 설명 |
|---|---|
| **PR까지 시간** | 이슈 할당 → PR 생성 소요 시간 |
| **CI 통과율** | 첫 번째 실행에서 CI를 통과한 PR 비율 |
| **PR당 검토 시간** | 리뷰어가 PR 하나에 소비한 평균 시간 |
| **문서 신선도** | `AGENTS.md` 마지막 업데이트 이후 경과일 (30일 초과 시 검토 필요) |

---

## AI 에이전트를 위한 안내

AI 에이전트인 경우 **[AGENT_SETUP.md](./AGENT_SETUP.md)**를 참조하세요. 기계 소비에 최적화된 상세한 설정 지침, 컨벤션, 구현 가이드가 포함되어 있습니다.

---

## 기여하기

1. Fork 및 클론
2. `.env.example`을 `.env`로 복사하고 값 입력
3. `./scripts/dev.sh`로 환경 검증
4. 브랜치 생성: `git checkout -b issue/YOUR-KEY`
5. 변경 후 `./scripts/harness/validate.sh` 실행
6. PR 템플릿을 사용하여 PR 오픈

---

## 라이선스

AGPL-3.0
