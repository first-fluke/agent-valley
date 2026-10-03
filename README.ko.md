# Agent Valley

격리된 Git worktree에서 AI Actor를 실행합니다. Linear/GitHub 이슈를 병렬로 처리하거나, 로컬 Chief Director에게 목표를 주고 계획·분담·검토·검증을 맡길 수 있습니다.

> Read in: [English](./README.md)

```
Linear Issue (Todo)
  → Webhook → Orchestrator → Git Worktree → Actor Session
  → Completion → Merge/PR → Done
```

트래커 모드는 상태 전환(Todo → In Progress → Done/Cancelled)을 관리하고 검증된 변경을 전달합니다. Chief Director 명령은 목표에 대한 계획, 작업별 검토, 검증 결과를 로컬에 저장합니다.

**TypeScript + Bun**으로 구축되었습니다. AgentSession 인터페이스로 **Claude Code, Codex, Antigravity, Cursor, Grok, Kimi, OpenCode**를 지원합니다.

사용자별 운용 과정, 수정 사항, 검증 범위와 남은 제약은 [운용 점검 보고서](./docs/reports/operability-audit-2026-10-03.md)에 있습니다.

---

## 작동 방식

1. Linear 또는 GitHub에서 이슈를 생성합니다 (또는 `bun av issue "description"`)
2. 트래커가 대시보드로 웹훅을 전송합니다
3. Orchestrator가 HMAC 서명을 검증하고 이슈를 In Progress로 전환합니다
4. DAG 스케줄러가 의존성을 확인합니다 — 차단된 이슈는 차단 이슈가 완료될 때까지 대기합니다
5. WorkspaceManager가 `workspace.root` 아래에 격리된 git worktree를 생성합니다
6. AgentRunnerService가 설정된 Actor CLI를 실행합니다
7. 검증 통과 후: 병합·푸시 또는 PR 생성, 트래커에 요약 게시, Done으로 전환
8. 실패 시: 지수 백오프 재시도(60s × 2^n, 최대 3회), 이후 에러 코멘트와 함께 취소
9. 슬롯 보충: 완료된 Actor가 용량을 반환하면 대기 중인 다음 이슈가 자동으로 시작됩니다

`actor.max_parallel`(하드웨어에서 자동 감지)까지 여러 이슈가 병렬로 실행됩니다.

---

## 빠른 시작

작업할 Git 레포에서 설치 스크립트를 실행합니다. 필요한 Node.js 26.10.0과 Bun 1.4.2를 준비하고 `av`를 설치한 뒤, 대화형 터미널에서 위자드를 실행합니다.

```bash
cd /absolute/path/to/repo
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
av order "Fix the login failure"
```

기본 위자드에서 작업 레포와 Chief Director 벤더·모델을 설정하고, 필요한 경우 검증 명령을 저장합니다. 선택한 Chief Director의 CLI 설치와 로그인을 진행하고 작업 레포의 최신 OMA CLI·스킬 준비도 기본 선택됩니다. 실패하면 재시도하거나 나중에 준비할 수 있습니다. 브라우저 로그인과 일부 인증 상태 확인은 사용자 입력이 필요합니다. 레포에는 커밋이 있어야 합니다. 설정을 저장하면 이후에는 목표만 전달하면 됩니다. [설치·첫 작업·복구 가이드](./docs/guides/environment-setup.md)를 참고하세요.

Chief Director가 Technical Director·Design Director·Marketing Director의 자문을 동시에 받아 목표를 성공 기준과 실행 가능한 검사로 구체화하고, 세 참모를 포함한 4~8명의 Actor와 사용 가능한 지원 CLI·설치된 OMA 스킬을 선택합니다. 독립된 Actor 최대 3명이 별도 worktree에서 병렬로 일하고, 검토를 통과한 변경을 통합한 뒤 후속 작업과 최종 검증을 진행합니다. `--parallel 1`은 순차 실행합니다. Technical Director는 비용·재사용·스택과 의존성 관리를, Design Director는 사용성·사용자 테스트·데이터와 다크패턴을 즐겨 사용하는 이탈 억제 전략을, Marketing Director는 홍보·고객 획득·매출·ROI를 맡습니다. 작업 결과를 검토하며 실패하면 수정·재배정·재계획을 판단합니다. 주문마다 쉬운 설명, 검증 결과, 남은 한계를 담은 보고서를 작성합니다. 트래커와 데몬 없이 실행됩니다. `--actor`와 `--model`은 해당 주문의 Chief Director 설정을 덮어쓰고, `--actors`는 직접 만든 팀을 사용합니다. 자세한 사용법은 [Chief Director 명령 가이드](./docs/guides/chief-missions.md)에 있습니다.

`--verify`와 저장된 검증 명령이 없으면 Chief Director가 원래 성공 기준에 연결된 파일·JSON·명시적인 테스트 검사를 설계합니다. 제공한 명령은 유지됩니다. 기본 감독 프로세스가 저장된 한도 안에서 작업 프로세스의 비정상 종료와 예약된 재시도를 복구합니다. `--no-supervise`는 직접 실행하며, 감독 프로세스나 컴퓨터가 멈춘 뒤에는 `av missions --watch`로 대상 주문을 이어갑니다. 인증 문제와 결과가 불명확한 외부 작업은 점검을 위해 멈춥니다. 재개 시 `--runs`, `--duration`, `--rounds`, 설정 가격에 따른 추정 비용 한도 `--cost`를 늘릴 수 있고 이미 사용한 예산은 유지됩니다. 비용 한도를 설정했는데 비용을 확인할 수 없으면 추가 호출을 멈춥니다. 실행 중인 호출이나 구독 요금까지 정확한 청구 상한을 보장하지는 않습니다.

실행 방법과 감독은 Chief Director가 판단하고, 목표와 실행 결과에 대한 운영 책임은 사용자가 갖습니다. Chief Director는 실제 행동과 검증 근거를 보고서에 남깁니다.

실측 사용량·실행 시간·성공 기록을 활용한 라우팅, 사용 가능한 다른 CLI 종류의 작업 검토, 레포별 조직 기억과 사업 지표 목표 검증도 지원합니다. 사용자가 설정한 Stripe 매출·HTTP JSON·파일 소스에서 실제 지표를 수집합니다. 측정 기간에는 대기하며, 목표가 충족되지 않으면 완료로 처리하지 않습니다. 보고 채널은 Slack·Discord·Telegram·Teams·Google Chat·Mattermost·Webhook 어댑터로 교체하거나 함께 사용할 수 있습니다. 보고서와 Aside MCP 캡처·영상을 실제 파일로 첨부하며, MP4 인코딩에는 ffmpeg가 필요합니다. [운영 기능과 첨부 전송 설정](./docs/guides/chief-integrations.md)을 참고하세요.

이슈 트래커 자동화는 `apps/dashboard`가 있는 Agent Valley 소스 체크아웃에서 실행합니다. 그곳에서 `bun av setup --mode tracker`, `bun av doctor`, `bun av up --dev`를 실행하고 `workspace.root`를 작업할 레포로 지정합니다.

Linear 웹훅은 CLI가 자동 등록을 시도합니다. 수동 등록 주소는 `{url}/api/webhook`, GitHub는 `{url}/api/webhook/github`입니다.
터널 프로바이더 기본값은 ngrok 이며, `av.yaml` 의 `tunnel.provider: cloudflare` 로 Cloudflare Tunnel 을 선택할 수 있습니다 (아래 설정 섹션 참조).

---

## CLI

```bash
bun av setup              # 로컬 주문 설정: 레포, Chief Director, 로그인, OMA, 검증 명령
bun av setup --mode tracker # Linear/GitHub 자동화 설정
bun av doctor             # 설정·실행 전제조건 진단
bun av dev                # 포그라운드로 시작 (파일 감시 + 자동 재시작)
bun av up --dev           # 프로덕션 빌드 없이 백그라운드 데몬으로 시작
bun av up                 # 대시보드 빌드 후 백그라운드 데몬으로 시작
bun av down               # 백그라운드 데몬 중지
bun av status             # Orchestrator 상태 조회
bun av top                # 실시간 Actor 상태 모니터
bun av logs               # 대시보드 로그 조회 (-n으로 라인 수 지정)
bun av login              # 팀 로그인 (Supabase 인증)
bun av logout             # 팀 로그아웃
bun av invite             # 팀 설정을 클립보드에 복사
bun av order --help       # Chief Director에게 목표 전달; --verify로 검증 명령 선택 제공
bun av missions           # 저장된 로컬 Chief Director 작업 목록
bun av missions --watch   # 대상 주문과 예약된 지표 관측을 저장 상태에서 재개
bun av reports list       # 서드파티 전송 기록 확인
bun av reports retry      # Actor 실행 없이 저장된 보고서·첨부 재전송
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

`--parent`, `--blocked-by`, `--breakdown`은 Linear 전용입니다. GitHub는 일반 이슈와 `--scope`를 지원합니다. 두 트래커 모두 `--raw`로 Claude의 설명 확장 없이 생성할 수 있습니다.

---

## 설정

### 설정 파일

두 개의 YAML 설정 파일이 시작 시 머지됩니다 (프로젝트 설정이 글로벌 설정보다 우선):

| 파일 | 범위 | 설명 |
|---|---|---|
| `~/.config/agent-valley/settings.yaml` | 글로벌 (사용자) | API 키, Actor 기본값, 팀 대시보드 |
| `av.yaml` | 프로젝트 | 팀 설정, 작업 경로, 프롬프트 템플릿, 라우팅 |

`av setup`을 실행하면 두 파일을 대화형으로 생성합니다. 포맷은 `av.example.yaml`을 참고하세요.

프로젝트 설정은 `av.yaml`만 사용하며, 위자드와 설정 편집도 이 파일로 저장합니다. 설정 키는 `actor:`입니다. Actor 프로필은 `director`, `actors`, `actorType`을 사용하고 기존 프로필 필드와 CLI 옵션은 호환 별칭으로 유지합니다.

### 글로벌 설정 (`~/.config/agent-valley/settings.yaml`)

```yaml
linear:
  api_key: lin_api_xxx

actor:
  type: claude          # 기본 Actor: claude / codex / antigravity / cursor / grok / kimi / opencode
  timeout: 3600
  max_retries: 3
  max_parallel: 3       # 동시 실행 가능한 Actor 수 (기본값: 하드웨어 감지 기반 권장치)

logging:
  level: info           # debug / info / warn / error
  format: json          # json / text

server:
  port: 9741

# 팀 대시보드 (선택 사항)
team:
  supabase_url: https://xxx.supabase.co
  supabase_anon_key: your-anon-key
  id: my-team
  display_name: my-node
```

### 프로젝트 설정 (`av.yaml`)

```yaml
# 트래커 선택 (v0.2+). 생략 시 linear 로 간주합니다.
tracker:
  kind: linear        # linear | github

linear:
  team_id: ACR
  team_uuid: uuid-xxx
  webhook_secret: whsec_xxx
  workflow_states:
    todo: state-uuid
    in_progress: state-uuid
    done: state-uuid
    cancelled: state-uuid

# GitHub 트래커 (v0.2+) — tracker.kind = github 일 때 사용합니다.
# github:
#   token_env: GITHUB_TOKEN
#   owner: my-org
#   repo: my-repo
#   webhook_secret: whsec_xxx
#   labels:
#     todo: valley:todo
#     in_progress: valley:wip
#     done: valley:done
#     cancelled: valley:cancelled

workspace:
  root: /absolute/path/to/target-repo

delivery:
  mode: merge           # merge (자동 병합+푸시) 또는 pr (draft PR 생성)

prompt: |
  You are working on {{issue.identifier}}: {{issue.title}}.
  {{issue.description}}
  Path: {{workspace_path}}

# 멀티 저장소 라우팅 (선택 사항)
routing:
  rules:
    - label: "backend"
      workspace_root: /path/to/backend
    - label: "frontend"
      workspace_root: /path/to/frontend
      actor_type: codex
      delivery_mode: pr
      verify_command: "pytest && mypy ."   # 이 라우트에 한해 아래 verify.command 를 덮어씁니다

# 검증 게이트 (코드 작업에 필수). 배포/PR 생성과 Done 전환 전에 실행되며,
# 실패 시 캡처된 출력을 컨텍스트로 기존 재시도 큐를 통해 다시 시도합니다.
# 대상 레포에 실제로 있는 검증 명령을 지정하세요.
verify:
  command: "bun run typecheck && bun run test"
  timeout_sec: 600

# 점수 기반 라우팅 (선택 사항)
scoring:
  model: haiku
  routes:
    easy:  { min: 1, max: 3, actor: antigravity }
    medium: { min: 4, max: 7, actor: codex }
    hard:  { min: 8, max: 10, actor: claude }

# Actor 예산 제한 (선택 사항, v0.2+). 생략 시 비활성.
# budget:
#   per_issue:
#     tokens: 2_000_000
#     usd: 5.00
#   per_day:
#     tokens: 20_000_000
#     usd: 50.00

# 웹훅 터널 (선택 사항, v0.3+). 생략 시 v0.2 기본값 ngrok.
# tunnel:
#   provider: cloudflare   # cloudflare | ngrok | none
#   cloudflare:
#     mode: quick          # quick (랜덤 *.trycloudflare.com URL) | named
#     # name: av-webhook           # mode: named 일 때 필수
#     # hostname: webhook.example.com  # mode: named 일 때 UI 표시용

# 관측성 (선택 사항, v0.2+). 둘 다 기본값 off.
# observability:
#   otel:
#     enabled: false
#     endpoint: http://localhost:4318
#     service_name: agent-valley
#   prometheus:
#     enabled: false
#     path: /api/metrics
```

**프롬프트 템플릿 변수:** `{{issue.identifier}}`, `{{issue.title}}`, `{{issue.description}}`, `{{workspace_path}}`, `{{attempt.id}}`, `{{retry_count}}`

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
│           ├── config/         YAML 설정 로더 (settings.yaml + av.yaml)
│           ├── domain/         순수 타입: Issue, Workspace, RunAttempt, DAG
│           ├── orchestrator/   상태 머신, Actor 러너, 재시도 큐, DAG 스케줄러
│           ├── sessions/       Actor 플러그인: Claude, Codex, Antigravity
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
├── AGENTS.md                 Actor 지침 (공유 진입점)
├── CLAUDE.md                 Claude Code 프로젝트 지침
└── av.example.yaml       프로젝트 설정 템플릿
```

### 클린 아키텍처 레이어

```
Presentation   대시보드 라우트 핸들러 (비즈니스 로직 없음)
     ↓
Application    Orchestrator (core / lifecycle / router / bus), AgentRunnerService
     ↓
Domain         Issue, Workspace, RunAttempt, DAG, ParsedWebhookEvent (순수 타입)
               + 포트: IssueTracker, WebhookReceiver, WorkspaceGateway, AgentRunnerPort
     ↓
Infrastructure Linear + GitHub 어댑터, git 작업, Actor 세션, 관측성
```

의존성 화살표는 **아래 방향으로만** 향합니다. `docs/architecture/LAYERS.md`를 참고하세요.

### 도메인 포트 레이어

v0.2부터 Application 레이어는 네 개의 도메인 포트를 통해 외부와 상호작용하며, 어댑터 교체만으로 다른 tracker / FS / Actor 백엔드를 지원합니다:

| 포트 | 역할 | 현재 어댑터 |
|---|---|---|
| `IssueTracker` | 이슈 조회 / 전이 / 코멘트 / 레이블 | `LinearTrackerAdapter`, `GitHubTrackerAdapter` |
| `WebhookReceiver<TEvent>` | 서명 검증 + `ParsedWebhookEvent` 파싱 | `LinearWebhookReceiver`, `GitHubWebhookReceiver` |
| `WorkspaceGateway` | 이슈별 worktree 생명주기 + 딜리버리 | `FileSystemWorkspaceGateway` |
| `AgentRunnerPort` | Actor spawn + 인터벤션용 `RunHandle` 노출 | `SpawnAgentRunnerAdapter` |

### Symphony 7개 컴포넌트

| # | 컴포넌트 | 역할 | 스펙 |
|---|---|---|---|
| 1 | **Workflow Loader** | 프롬프트 템플릿 렌더링 + 입력 살균 | `docs/specs/workflow-loader.md` |
| 2 | **Config Layer** | 타입 기반 설정 (Zod) + `$VAR` 환경 변수 해석 | `docs/specs/config-layer.md` |
| 3 | **Tracker Client** | Linear GraphQL — 이슈 조회, 상태 전환, 코멘트, HMAC 검증 | `docs/specs/tracker-client.md` |
| 4 | **Orchestrator** | 웹훅 이벤트 핸들러, 상태 머신, 재시도 큐, DAG 스케줄러 | `docs/specs/orchestrator.md` |
| 5 | **Workspace Manager** | 이슈별 git worktree 생성, 병합/PR, 정리 | `docs/specs/workspace-manager.md` |
| 6 | **Actor Runner** | AgentSession 추상화, 타임아웃 강제, 병렬 실행 | `docs/specs/agent-runner.md` |
| 7 | **Observability** | 구조화된 JSON 로그, 시스템 메트릭, SSE 상태 표면 | `docs/specs/observability.md` |

### Actor Session 플러그인

| Actor | 설정 값 | 실행 파일 |
|---|---|---|
| Claude Code | `claude` | `claude` |
| Codex | `codex` | `codex` |
| Antigravity | `antigravity` | `agy` |
| Cursor | `cursor` | `cursor-agent` |
| Grok | `grok` | `grok` |
| Kimi | `kimi` | `kimi` |
| OpenCode | `opencode` | `opencode` |

`registerSession()`을 통해 확장 가능 — `AgentSession` 인터페이스를 구현하여 커스텀 Actor를 추가하세요.

---

## 대시보드

실시간 Actor 상태를 보여주는 PixiJS 렌더링 오피스 장면:

- **Actor 캐릭터** — 이슈 식별자 말풍선이 있는 책상의 Actor
- **오피스 시각화** — 책상이 `actor.max_parallel`에 맞게 조정, 커피 머신, 서버 랙 등
- **운용 패널** — 의존성 차단 사유, 재시도 이유와 예정 시각
- **시스템 메트릭** — CPU, 메모리, 가동 시간
- **SSE 실시간 이벤트** — actor.start, actor.done, actor.failed 즉시 업데이트
- **팀 HUD** — 멀티 노드 뷰 (Supabase 설정 필요)

### API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|---|---|---|
| `/api/webhook` | POST | Linear 웹훅 수신기 (HMAC-SHA256 검증) |
| `/api/webhook/github` | POST | GitHub 웹훅 수신기 (HMAC-SHA256 검증) |
| `/api/events` | GET | 실시간 대시보드 업데이트를 위한 SSE 스트림 |
| `/api/status` | GET | Orchestrator 상태 JSON 스냅샷 |
| `/api/health` | GET | 헬스 체크 (Orchestrator 초기화 실패 또는 중지 시 503) |
| `/api/intervention` | POST | 라이브 Actor 제어. 기본은 로컬 접근, 토큰 설정 시 인증 필요 |
| `/api/metrics` | GET | Prometheus 메트릭 (`observability.prometheus.enabled` 시 활성화) |

---

## 주요 기능

### GitHub Issues 지원 (v0.2+)

Linear 외에 GitHub Issues로도 오케스트레이터를 구동할 수 있습니다. `av.yaml` 의 `tracker.kind: github` 로 설정하고 `github:` 섹션만 채우면, 도메인 `IssueTracker` / `WebhookReceiver` 포트가 투명하게 교체됩니다. 두 트래커는 동일한 오케스트레이션·재시도·딜리버리 파이프라인을 공유합니다.

### 관측성 (v0.2+)

OpenTelemetry OTLP HTTP 트레이스와 Prometheus 메트릭이 내장돼 있으며, **기본값은 둘 다 off** 입니다. `av.yaml` 의 `observability` 섹션으로 배포별로 활성화합니다. 활성화 시:

- Actor start/done/failed, 웹훅, DAG 이벤트마다 OTel 스팬이 발행됩니다.
- `GET /api/metrics` 가 Prometheus 포맷(활성 Actor, 재시도 큐 크기, 완료/실패 카운트, DAG 사이클 감지)을 서빙합니다.

### Actor 예산 제한 (v0.2+)

이슈당 / 일별 토큰·비용 한도로 폭주하는 Actor를 차단합니다. 예산은 각 spawn 직전 (`BudgetService.checkBeforeSpawn`) 에서 평가되며, 초과 시 spawn 없이 실행 가능한 에러 코멘트와 함께 이슈가 cancelled 로 전이됩니다.

### 라이브 인터벤션 (v0.2+)

대시보드에서 실행 중인 Actor를 제어할 수 있습니다 (`POST /api/intervention`):

- `pause` / `resume` — Codex 네이티브 (JSON-RPC)
- `append_prompt` — Codex / Antigravity ACP 는 네이티브, stateless Claude 는 cancel + 재스폰
- `abort` — 세션 강제 종료

제어 명령은 `InterventionBus`를 통과합니다. 인터벤션 토큰이 없으면 로컬 요청만 허용합니다. `SYMPHONY_INTERVENTION_TOKEN`을 설정하면 로컬·원격 요청 모두 일치하는 bearer 토큰 또는 브라우저 세션이 필요합니다. 토큰 설정 시 원격 플래그는 필요하지 않으며, 토큰 없이 `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1`만 설정하면 모든 요청을 거부합니다. [대시보드 접근 설정](./docs/guides/environment-setup.md#dashboard-and-webhook-access)을 참고하세요.

### DAG 의존성 스케줄링

`blocked_by` 관계가 있는 이슈는 모든 차단 이슈가 완료될 때까지 대기합니다. 차단 이슈가 완료되면 DAG 스케줄러가 연쇄적으로 차단 해제된 이슈를 디스패치합니다. 순환 참조는 감지되어 무시됩니다.

### 재시도 큐

실패한 Actor 실행은 지수 백오프로 재시도됩니다 (`60s × 2^(attempt-1)`, 최대 3회). 워크스페이스 생성 실패와 상태 전환 실패도 재시도됩니다. 최대 재시도 횟수 초과 시 → 에러 코멘트와 함께 이슈가 취소됩니다.

### 안전망

- 커밋되지 않은 Actor 작업을 감지하여 전달 전에 자동 커밋
- PR 모드에서 안전망 draft PR 생성
- SIGTERM/SIGINT 시 우아한 종료 — 실행 중인 모든 Actor 중지
- 핫 리로드 정리 — 새 Orchestrator 인스턴스 시작 전에 이전 인스턴스 중지

### 시작 동기화

부팅 시 Orchestrator가 설정된 트래커에서 모든 Todo + In Progress 이슈를 가져와 DAG 캐시를 재조정합니다. 기존 진행 중인 이슈는 자동으로 재개됩니다.

---

## 개발

```bash
bun run test                    # Vitest 테스트 실행
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

- **HMAC-SHA256** 웹훅 서명 검증으로 모든 Linear / GitHub 수신 이벤트 확인
- **프롬프트 인젝션 방어** — `av.yaml`의 프롬프트 템플릿은 신뢰됨, 이슈 본문은 항상 진입점에서 살균
- **최소 권한** — Actor는 할당된 worktree 내에서만 작동
- **시크릿 관리** — 시크릿은 `av.yaml`과 `settings.yaml`에만 저장 (gitignore 처리), pre-commit 시크릿 탐지
- **Fetch 타임아웃** — 모든 트래커 API 호출에 30초 타임아웃
- **인터벤션 접근** — 기본은 로컬 전용입니다. `SYMPHONY_INTERVENTION_TOKEN` 설정 시 로컬·원격 모두 인증을 요구합니다. 브라우저 제어 요청에는 일치하는 Origin이 필요하며 API 클라이언트는 유효한 bearer 토큰을 사용합니다. 토큰 없이 원격 플래그만 설정하면 모든 요청을 거부합니다.
- **샌드박스 실행** — 스폰되는 모든 Actor CLI는 OS 수준 샌드박스(macOS는 `sandbox-exec`, Linux는 `bwrap`) 안에서 실행되며, 샌드박스를 사용할 수 없으면 `SYMPHONY_ALLOW_UNSANDBOXED=1` 을 명시적으로 설정하지 않는 한 스폰이 거부됩니다(fail-closed)
- **감사 로깅** — 모든 Actor 작업을 구조화된 JSON으로 기록

전체 문서: `docs/harness/SAFETY.md`

---

## 아키텍처 제약 사항

| # | 규칙 | 근거 |
|---|---|---|
| 1 | Domain 레이어에 프레임워크 import 금지 | Domain은 순수하고 테스트 가능하게 유지 |
| 2 | 라우터에 비즈니스 로직 금지 | Presentation은 Application에 위임 |
| 3 | 하드코딩된 시크릿 금지 | 설정 YAML만 사용 (gitignore 처리) |
| 4 | 이슈 본문은 신뢰할 수 없음 | 경계에서 살균 |
| 5 | 파일당 최대 500줄 | 가독성 |
| 6 | Orchestrator 외부에서 공유 가변 상태 금지 | 단일 상태 권한 |
| 7 | 에러 메시지에 수정 지침 포함 필수 | Actor가 에러에서 자가 교정 |

예제가 포함된 전체 목록: `docs/architecture/CONSTRAINTS.md`

---

## AI Actor를 위한 안내

이 저장소를 읽고 있는 AI Actor라면, 자세한 설정 지침, 규칙, 구현 가이드는 **[AGENTS.md](./AGENTS.md)**를 참고하세요.

Claude Code 하위 Actor는 `.claude/agents/`에서 사용 가능합니다:
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
