# DAG-Based Issue Dependency Scheduling

> Status: Design approved
> Created: 2026-03-22

## Problem

현재 Orchestrator는 이슈를 독립적으로 처리한다. 이슈 간 의존성(선후행 관계)을 인식하지 못하므로, 선행 작업이 완료되지 않은 상태에서 후행 이슈 에이전트가 실행될 수 있다. 또한 병렬 실행 가능한 이슈들을 식별하지 못해 최대 병렬성을 확보하지 못한다.

## Solution

Linear의 sub-issue(parent/child)와 issue relation(blocks/blocked by)을 모두 활용하여 DAG(Directed Acyclic Graph)를 구성하고, 위상 정렬 기반으로 실행 순서를 결정한다.

- Sub-issue: 작업 분해 (기본 병렬)
- Relation (blocks/blocked by): 순서 제약 추가
- 명시적 제약이 없으면 최대 병렬이 기본값

## Design Decisions

| # | 항목 | 결정 | 이유 |
|---|---|---|---|
| 1 | 관계 소스 | Sub-issue + Relation 둘 다 | sub-issue만으로는 child 간 순서 표현 불가, relation만으로는 그룹핑 불가 |
| 2 | 팀 스코프 | 같은 팀 내 이슈만 | 현재 단일 팀 구조, 크로스 팀은 향후 확장 |
| 3 | 이슈 분해 | CLI에서 Claude 자동 분해 + 사용자 확인 후 일괄 생성 | 서버 자동 분해는 예측 불가능 |
| 4 | Parent 완료 | 모든 child Done 시 자동 Done + 종합 요약 코멘트 | child PR 링크, 결과 요약 포함 |
| 5 | 선행 이슈 취소 시 | 대기 유지 + "선행 이슈 취소됨" 알림 코멘트 | 취소 의도가 다양하므로 사람이 판단 |
| 6 | DAG 상태 관리 | 로컬 JSON 캐시 + 웹훅 기반 부분 갱신 + startup sync 검증 | 재시작 시 빠른 복구, 해시 비교 불필요 |
| 7 | DAG 노드 범위 | 열린 이슈만 (Todo + InProgress + waiting) | Done/Cancelled 이슈는 DAG에 포함하지 않음. DAG에 없는 blocker = 이미 해소 |

## Architecture

### Layer Assignment

```
Domain          DagNode, DagCache types, cycle detection (pure functions)
Application     DagScheduler (new), Orchestrator changes, completion-handler changes
Infrastructure  Linear client (relations/parent/children query + mutations)
Presentation    CLI issue.ts (--parent, --blocked-by, --breakdown options)
```

### Data Model

```typescript
// src/domain/models.ts — 추가

interface DagNode {
  issueId: string
  identifier: string
  status: "waiting" | "ready" | "running" | "done" | "cancelled"
  parentId: string | null
  children: string[]
  blockedBy: string[]       // 이 이슈가 기다리는 이슈 IDs
  blocks: string[]          // 이 이슈가 막고 있는 이슈 IDs (역방향 인덱스)
}

interface DagCache {
  version: number
  updatedAt: string
  nodes: Record<string, DagNode>
}
```

```typescript
// src/domain/models.ts — Issue 확장

interface Issue {
  // ... existing fields
  parentId: string | null
  children: string[]
  relations: IssueRelation[]
}

interface IssueRelation {
  type: "blocks" | "blocked_by" | "related" | "duplicate"
  relatedIssueId: string
  relatedIdentifier: string
}
```

```typescript
// src/domain/models.ts — OrchestratorRuntimeState 확장

interface OrchestratorRuntimeState {
  isRunning: boolean
  activeWorkspaces: Map<string, Workspace>
  waitingIssues: Map<string, WaitingEntry>   // NEW: blocked by dependencies
  lastEventAt: string | null
}

interface WaitingEntry {
  issueId: string
  identifier: string
  blockedBy: string[]     // 아직 Done이 아닌 blocker IDs
  enqueuedAt: string
}
```

### DAG Scheduler (new component)

```
src/orchestrator/dag-scheduler.ts

DagScheduler {
  // DAG construction
  buildFromIssues(issues: Issue[]): DagCache

  // Query — "unresolved" = blocker가 DAG에 노드로 존재함 (= 아직 열림)
  getUnresolvedBlockers(issueId: string): string[]
  getReadyIssues(): string[]          // unresolved blockers가 0인 이슈들
  getUnblockedByCompletion(issueId: string): string[]
  allChildrenDone(parentId: string): boolean

  // Mutation (webhook-driven updates)
  updateNodeStatus(issueId: string, status: DagNode["status"]): void
  addRelation(issueId: string, relatedId: string, type: string): void
  removeRelation(issueId: string, relatedId: string): void
  addChildIssue(parentId: string, childId: string): void

  // Persistence
  loadCache(): Promise<DagCache>
  saveCache(): Promise<void>
  reconcileWithLinear(issues: Issue[]): void  // startup sync 시 캐시 vs Linear 비교

  // Integrity
  detectCycles(): string[][]           // returns list of cycles (issue ID arrays)
}
```

**Write serialization**: 동시 웹훅 처리 시 JSON 파일 충돌 방지

```typescript
class DagScheduler {
  private writeQueue: Promise<void> = Promise.resolve()

  async update(fn: (state: DagCache) => DagCache): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const state = await this.loadCache()
      const updated = fn(state)
      await this.saveCache(updated)
    })
    return this.writeQueue
  }
}
```

**Cycle detection**: DAG 구성 시 위상 정렬(Kahn's algorithm)로 사이클 탐지. 사이클 발견 시 관련 이슈에 경고 코멘트 + 해당 엣지 무시.

**Node scope**: DAG에는 열린 이슈(Todo, InProgress, waiting)만 포함. Done/Cancelled 이슈는 노드로 추가하지 않는다. `blockedBy`에 있는 issueId가 DAG에 노드로 존재하지 않으면 "이미 해소된 blocker"로 간주하여 제약을 무시한다. 이 규칙으로 Done 이슈를 별도 조회하는 API 호출을 제거한다.

### Orchestrator Flow Changes

**handleIssueTodo (modified)**:

```
handleIssueTodo(issue):
  blockers = dagScheduler.getUnresolvedBlockers(issue.id)
  if (blockers.length > 0):
    waitingIssues.set(issue.id, { blockedBy: blockers })
    comment: "대기 중 — {blockerIdentifiers} 완료 후 자동 시작됩니다"
    return
  // existing logic (tryAcceptOrQueue → InProgress → spawn agent)
```

**completion-handler onComplete (extended)**:

```
onComplete(issue):
  // ... existing logic (safety net, delivery, exit assessment)

  dagScheduler.updateNodeStatus(issue.id, "done")

  // 1. Cascade trigger: unblock waiting issues
  unblockedIssues = dagScheduler.getUnblockedByCompletion(issue.id)
  for (unblocked of unblockedIssues):
    waitingIssues.delete(unblocked.id)
    handleIssueTodo(unblocked)

  // 2. Parent auto-complete
  if (issue.parentId && dagScheduler.allChildrenDone(issue.parentId)):
    childSummaries = dagScheduler.getChildrenSummaries(issue.parentId)
    postParentSummaryComment(issue.parentId, childSummaries)
    updateIssueState(issue.parentId, done)
```

**handleIssueLeftInProgress (extended)**:

```
handleIssueLeftInProgress(issueId):
  // ... existing logic (kill agent, cleanup)

  if (newState === cancelled):
    dagScheduler.updateNodeStatus(issueId, "cancelled")
    // Find blocked issues and post warning comment
    blocked = dagScheduler.getBlockedIssues(issueId)
    for (b of blocked):
      comment on b: "선행 이슈 {identifier}가 취소됨 — 확인 필요"
```

### Webhook Handler Extension

현재 `type !== "Issue"`이면 무시. `IssueRelation` 웹훅 추가 처리:

```typescript
// webhook-handler.ts

if (data.type === "IssueRelation") {
  // Linear sends: { type: "IssueRelation", action: "create"|"remove",
  //   data: { issueId, relatedIssueId, type: "blocks"|... } }
  return {
    kind: "relation",
    action: data.action,
    issueId: data.data.issueId,
    relatedIssueId: data.data.relatedIssueId,
    relationType: data.data.type,
  }
}
```

Orchestrator에서 relation 이벤트 라우팅:

```
onRelationEvent(event):
  if (event.action === "create"):
    dagScheduler.addRelation(event.issueId, event.relatedIssueId, event.relationType)
  if (event.action === "remove"):
    dagScheduler.removeRelation(event.issueId, event.relatedIssueId)
    // 관계 해제로 대기 이슈가 풀릴 수 있음 → 재평가
    reevaluateWaitingIssues()
```

### Linear API Additions

**Queries — `ISSUES_BY_STATE_QUERY` 확장**:

```graphql
nodes {
  id identifier title description url
  state { id name type }
  team { id key }
  labels { nodes { name } }
  # NEW
  parent { id identifier }
  children { nodes { id identifier state { id name type } } }
  relations {
    nodes {
      type
      relatedIssue { id identifier state { id name type } }
    }
  }
}
```

**Mutations — 신규**:

```graphql
# Sub-issue 생성
mutation CreateSubIssue($teamId: String!, $parentId: String!, $title: String!, $description: String!, $stateId: String!) {
  issueCreate(input: { teamId: $teamId, parentId: $parentId, title: $title, description: $description, stateId: $stateId }) {
    success
    issue { id identifier title url }
  }
}

# Relation 생성
mutation CreateIssueRelation($issueId: String!, $relatedIssueId: String!, $type: String!) {
  issueRelationCreate(input: { issueId: $issueId, relatedIssueId: $relatedIssueId, type: $type }) {
    issueRelation { id type }
  }
}
```

### CLI Extensions

```bash
# Sub-issue 생성
bun av issue "JWT 미들웨어" --parent ACR-10

# Relation 설정
bun av issue "Login API" --blocked-by ACR-12

# 자동 분해 (Claude가 sub-issues + relations 제안 → 사용자 확인 → 일괄 생성)
bun av issue "인증 시스템 구축" --breakdown
```

**--breakdown 플로우**:

1. Claude가 큰 이슈를 sub-issues로 분해 + 의존관계 추론
2. DAG 미리보기 표시 (트리 + 의존성 화살표)
3. 사용자 확인
4. Parent issue 생성 → sub-issues 생성 → relations 설정
5. 실패 시 생성된 이슈 ID 목록 출력 (수동 정리 가능)

## Edge Cases

| 케이스 | 처리 |
|---|---|
| 사이클 (A blocks B, B blocks A) | 위상 정렬로 탐지, 경고 코멘트 + 해당 엣지 무시 |
| 이미 running인 이슈에 blocked by 추가 | 무시 (이미 실행 중), 코멘트로 경고만 |
| blocker가 Done 아닌 상태로 삭제(remove) | blocker 해제로 간주 → 대기 이슈 재평가 |
| 모든 children Done 후 새 child 추가 | parent 상태 변경 없음, 새 child만 독립 실행 |
| startup sync 시 캐시 vs Linear 불일치 | Linear를 source of truth로, 캐시 덮어쓰기 |
| 외부 blocker (Symphony 미추적 이슈) | DAG에 노드 없음 = 해소로 간주. 단, 해당 이슈가 실제로 열려있으면 웹훅으로 DAG에 추가됨 |
| Done/Cancelled 이슈가 blocker에 있음 | DAG에 노드 없으므로 자동 해소 — 추가 API 호출 불필요 |
| --breakdown 중간 실패 (부분 생성) | 생성된 이슈 ID 목록 출력, 수동 정리 안내 |

## Affected Files

| File | Change Type |
|---|---|
| `src/domain/models.ts` | Issue 확장 (parentId, children, relations), DagNode/DagCache 타입 추가, WaitingEntry 추가 |
| `src/orchestrator/dag-scheduler.ts` | **NEW** — DAG 구성, 쿼리, 갱신, 캐시 I/O, 사이클 탐지 |
| `src/orchestrator/orchestrator.ts` | handleIssueTodo 분기 추가, waitingIssues 관리, relation 웹훅 라우팅 |
| `src/orchestrator/completion-handler.ts` | 연쇄 트리거, parent 자동 완료 + 요약 코멘트 |
| `src/tracker/linear-client.ts` | GraphQL 쿼리 확장 (relations, parent, children), mutation 추가 (createSubIssue, createRelation) |
| `src/tracker/webhook-handler.ts` | IssueRelation 웹훅 파싱, WebhookEvent 타입 확장 |
| `src/tracker/types.ts` | LinearIssueNode 확장, RelationWebhookEvent 타입 추가 |
| `src/cli/issue.ts` | --parent, --blocked-by, --breakdown 옵션 추가 |
| `src/config/env.ts` | DAG 캐시 파일 경로 설정 (선택) |

## Implementation Order

1. **Domain** — 타입 확장 (models.ts)
2. **Infrastructure** — Linear client 쿼리/mutation 확장 + webhook handler IssueRelation 처리
3. **Application** — DagScheduler 신규 컴포넌트
4. **Application** — Orchestrator + completion-handler 수정 (DAG 통합)
5. **Presentation** — CLI issue.ts 확장 (--parent, --blocked-by)
6. **Presentation** — CLI --breakdown 기능
7. **Integration test** — 전체 플로우 E2E 검증

## WaitingIssues vs RetryQueue

| | RetryQueue | waitingIssues |
|---|---|---|
| 목적 | 일시적 실패 재시도 | 구조적 의존성 대기 |
| 트리거 | 시간 경과 (exponential backoff) | 선행 이슈 완료 이벤트 |
| 최대 횟수 | maxRetries 후 Cancelled | 제한 없음 (blocker 완료까지) |
| 재시작 시 | 인메모리, 소실됨 | DAG 캐시에서 복구 |
