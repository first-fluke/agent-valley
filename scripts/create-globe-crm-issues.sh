#!/usr/bin/env bash
# Batch create Globe CRM Linear issues via `bun av issue --raw -y`
# Usage: bash scripts/create-globe-crm-issues.sh
set -euo pipefail

CD="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CD"

issue() {
  local input="$1"
  local title="${input%%$'\n'*}"
  echo "  → $title"
  bun av issue --raw -y "$input"
}

echo "🌍 Creating Globe CRM issues..."
echo ""

# ── Phase 0: Foundation ──────────────────────────────────────────────────────
echo "── Phase 0: Foundation ──"

issue "chore(monorepo): scaffold Globe CRM monorepo with mise, docker-compose, root AGENTS.md
## Goal
mise.toml, biome.json, docker-compose (PG+PostGIS+Redis+MinIO), root AGENTS.md, CLAUDE.md를 포함한 polyglot monorepo 초기 세팅.

## Requirements
- \`.mise.toml\` — Node 22, Python 3.12, Flutter 3, Terraform 1.x 버전 핀
- \`docker-compose.yml\` — PostgreSQL 16 + PostGIS, Redis 7, MinIO 서비스
- \`biome.json\` — root 레벨 lint/format 설정
- Root \`AGENTS.md\` — 프로젝트 개요, 설치, 아키텍처 다이어그램
- Root \`CLAUDE.md\` — Claude Code 지시사항

## Notes
- Phase: 0 | ID: F-01 | Priority: P0 | deps: none"

issue "feat(api): init FastAPI project with uv, SQLAlchemy async, Alembic, lib/ utilities
## Goal
FastAPI 백엔드 프로젝트 초기화. pyproject.toml, src/main.py, alembic, lib/ 공통 유틸리티.

## Requirements
- pyproject.toml (FastAPI, SQLAlchemy[asyncio], asyncpg, alembic, redis, miniopy-async, pyjwt)
- src/main.py — FastAPI app + /health
- src/lib/ — database.py, redis.py, storage.py, exceptions.py, pagination.py, auth.py
- api/AGENTS.md — Router→Service→Repository 패턴 문서
- 응답 봉투: { data, meta, errors } / 에러: { error: { code, message, details } }

## Notes
- Phase: 0 | ID: F-02 | Priority: P0 | deps: none"

issue "feat(web): init Next.js 16 with TailwindCSS v4, shadcn/ui, TanStack, nuqs, Jotai
## Goal
Next.js 16 웹앱 초기화 + 핵심 의존성 설치.

## Requirements
- create-next-app + App Router
- TailwindCSS v4 + shadcn/ui init
- TanStack Query + TanStack Form + nuqs + Jotai
- Biome lint
- apps/web/AGENTS.md

## Notes
- Phase: 0 | ID: F-03 | Priority: P0 | deps: none"

issue "feat(mobile): init Flutter project with Riverpod 3, go_router, Forui, Dio, Drift
## Goal
Flutter 모바일 앱 초기화 + 4탭 bottom nav 셸.

## Requirements
- pubspec.yaml: riverpod 3, go_router, forui, dio, drift, flutter_inappwebview, connectivity_plus
- StatefulShellRoute 기반 4탭 (Globe/Graph/Contacts/Settings)
- 테마 설정 (light/dark)
- apps/mobile/AGENTS.md

## Notes
- Phase: 0 | ID: F-04 | Priority: P0 | deps: none"

issue "feat(globe): create reusable Globe.gl HTML template with JS Bridge message schema
## Goal
Web+Flutter 공유 Globe.gl HTML/JS/CSS 번들 + 타입 JS Bridge 스키마.

## Requirements
- public/globe/index.html — Globe.gl 초기화, 핀/아크/클러스터 렌더링
- JS Bridge: FLY_TO, HIGHLIGHT_CONTACT, SET_THEME, SET_MODE (inbound) / PIN_TAPPED, CLUSTER_TAPPED, LOCATION_SELECTED, READY (outbound)
- 핀: 프사+이름 48dp 터치타겟
- 아크: 굵기=빈도, 대시패턴=유형 (WCAG 1.4.1)
- 다크모드 테마 전환

## Notes
- Phase: 0 | ID: F-05 | Priority: P0 | deps: none"

issue "chore(ci): setup GitHub Actions CI for web, api, mobile matrix
## Goal
PR에서 web/api/mobile 3 job 병렬 CI 파이프라인.

## Requirements
- .github/workflows/ci.yml
- Web: Biome lint + tsc --noEmit + vitest
- API: ruff lint + mypy + pytest
- Mobile: flutter analyze + flutter test
- .github/PULL_REQUEST_TEMPLATE.md

## Notes
- Phase: 0 | ID: F-06 | Priority: P0 | deps: none"

# ── Phase 1: Core API + DB ───────────────────────────────────────────────────
echo ""
echo "── Phase 1: Core API + DB ──"

issue "feat(db): create SQLAlchemy models + Alembic migrations with PostGIS
## Goal
전체 데이터 모델 구현 + 초기 마이그레이션.

## Requirements
- Models: User, UserAuth, Contact(soft-delete+PostGIS POINT), Organization, Experience, Tag, contact_tags, Meeting, meeting_contacts, ContactRelationship
- ContactRelationship: CHECK(contact_a_id < contact_b_id), UNIQUE(user_id, a_id, b_id)
- Tag: UNIQUE(user_id, name)
- Junction tables: composite PK
- 모든 엔티티 created_at/updated_at, Contact에 deleted_at

## Notes
- Phase: 1 | ID: A-01 | Priority: P0 | deps: F-01, F-02"

issue "feat(api/auth): OAuth Google/GitHub + JWT + refresh token Redis + rate limiting
## Goal
OAuth 인증 + JWT 발급/갱신/로그아웃 + /auth/me.

## Requirements
- GET /auth/callback — OAuth 리다이렉트 수신
- POST /auth/token — code→JWT, UserAuth 생성/조회
- POST /auth/refresh — Redis refresh token으로 JWT 갱신
- DELETE /auth/logout — refresh token 무효화
- GET /auth/me — 현재 유저 프로필
- Rate limit: 10/min/IP
- CurrentUser dependency (JWT→user_id)

## Notes
- Phase: 1 | ID: A-02 | Priority: P0 | deps: A-01"

issue "feat(api/contacts): CRUD + cursor pagination + filters + soft-delete + user-scoping
## Goal
연락처 CRUD API. Repository에서 user_id 스코핑 강제.

## Requirements
- GET /contacts (cursor+tag/country/city/q 필터)
- POST/GET/:id/PUT/PATCH/DELETE(soft)
- Repository: WHERE user_id = :current_user 강제
- 타 유저 접근 시 404

## Notes
- Phase: 1 | ID: A-03 | Priority: P0 | deps: A-01, A-02"

issue "feat(api/tags): CRUD + attach/detach contact-tag associations
## Goal
태그 CRUD + 연락처-태그 연결/해제.

## Requirements
- GET/POST/PUT/DELETE /tags
- POST/DELETE /contacts/:id/tags/:tag_id
- UNIQUE(user_id, name) → 409

## Notes
- Phase: 1 | ID: A-04 | Priority: P1 | deps: A-01, A-02"

issue "feat(api/organizations): autocomplete search + create with dedup
## Goal
Organization 자동완성 + 중복 방지 생성.

## Requirements
- GET /organizations?q= (ILIKE 상위 10)
- POST /organizations (name+type dedup)

## Notes
- Phase: 1 | ID: A-05 | Priority: P1 | deps: A-01, A-02"

issue "feat(api/experiences): CRUD with organization FK
## Goal
경력/학력 CRUD.

## Requirements
- GET/POST /contacts/:id/experiences
- PUT/DELETE /contacts/:contact_id/experiences/:id
- organization_id FK, role(nullable), major(nullable)

## Notes
- Phase: 1 | ID: A-06 | Priority: P1 | deps: A-01, A-02, A-05"

issue "feat(api/meetings): CRUD with attendee contact_ids + cursor pagination
## Goal
미팅 CRUD + 참석자 다대다.

## Requirements
- GET /meetings (cursor+date_from/date_to/contact_id)
- POST (attendee contact_ids), GET/:id, PUT, DELETE
- GET /contacts/:id/meetings

## Notes
- Phase: 1 | ID: A-07 | Priority: P1 | deps: A-01, A-02, A-03"

issue "feat(api/upload): MinIO presigned URL for avatar upload
## Goal
아바타 업로드 presigned URL 발급.

## Requirements
- POST /upload/avatar → presigned URL (5MB, image/*)
- Rate limit: 5/min/user

## Notes
- Phase: 1 | ID: A-08 | Priority: P1 | deps: F-01, A-02"

# ── Phase 2: Web + Mobile Shell ──────────────────────────────────────────────
echo ""
echo "── Phase 2: Web + Mobile Shell ──"

issue "feat(web): app layout + responsive Side/Bottom nav + API client
## Goal
App Router 레이아웃 + 반응형 네비게이션 + API 클라이언트.

## Requirements
- (auth)/(main) route groups
- Desktop SideNav / Mobile BottomNav (AppNav + useResponsive)
- 4탭: Globe/Graph/Contacts/Settings
- TanStack Query provider + 응답 봉투 타입

## Notes
- Phase: 2 | ID: W-01 | Priority: P0 | deps: F-03"

issue "feat(web/auth): OAuth login + JWT storage + redirect guard
## Goal
웹 OAuth 로그인 + 토큰 관리.

## Requirements
- OAuth 로그인 페이지 (Google/GitHub)
- callback→token→JWT 저장
- 미인증 리다이렉트
- /auth/me 연동

## Notes
- Phase: 2 | ID: W-02 | Priority: P0 | deps: F-03, A-02"

issue "feat(web/globe): react-globe.gl with dynamic import, ErrorBoundary, skeleton
## Goal
react-globe.gl 통합. SSR-safe + 에러/로딩 처리.

## Requirements
- next/dynamic ssr:false
- ErrorBoundary + Suspense + skeleton PNG
- 핀 렌더(프사+이름), 카메라 Jotai atom
- 드래그 회전, 스크롤 줌

## Notes
- Phase: 2 | ID: W-03 | Priority: P0 | deps: F-03, F-05"

issue "feat(mobile): StatefulShellRoute 4-tab nav + Dio API client
## Goal
Flutter 앱 셸 + API 클라이언트.

## Requirements
- StatefulShellRoute 4탭
- 플랫폼별 FAB (Android↘ iOS↗)
- Dio + JWT interceptor
- Forui 테마

## Notes
- Phase: 2 | ID: M-01 | Priority: P0 | deps: F-04"

issue "feat(mobile/auth): OAuth WebView + secure storage JWT
## Goal
Flutter OAuth 로그인 + 토큰 보안 저장.

## Requirements
- OAuth WebView (Google/GitHub)
- flutter_secure_storage JWT
- 미인증 리다이렉트
- /auth/me 연동

## Notes
- Phase: 2 | ID: M-02 | Priority: P0 | deps: F-04, A-02"

issue "feat(mobile/globe): WebView + Globe.gl asset bundle + JS Bridge + gesture resolution
## Goal
Flutter Globe.gl WebView 통합 + JS Bridge + 제스처 충돌.

## Requirements
- flutter_inappwebview + hardwareAcceleration
- assets/globe/ 번들 로딩
- JS Bridge 구현 (typed messages)
- iOS popGestureDismissable:false
- Android PopScope
- 로딩 오버레이

## Notes
- Phase: 2 | ID: M-03 | Priority: P0 | deps: F-04, F-05"

# ── Phase 3: Features ────────────────────────────────────────────────────────
echo ""
echo "── Phase 3: Features ──"

issue "feat(web/contacts): virtual list + infinite scroll + search/filter with nuqs
## Goal
연락처 리스트. 가상 스크롤 + URL 필터.

## Requirements
- @tanstack/react-virtual + TanStack Query infinite (cursor)
- CommandInput 검색 + Select 정렬 + ToggleGroup 태그 (nuqs)
- 빈 상태

## Notes
- Phase: 3 | ID: W-04 | Priority: P0 | deps: W-01, W-02, A-03"

issue "feat(web/contacts): detail screen with profile, timeline, meetings, tags
## Goal
연락처 상세 화면.

## Requirements
- 프로필(Avatar+SNS), 경력 타임라인(Separator+Card), 만남(Table), 태그(Badge+Popover)
- [지구본보기] [관계보기] 액션

## Notes
- Phase: 3 | ID: W-05 | Priority: P1 | deps: W-04, A-04, A-06, A-07"

issue "feat(web/contacts): 3-step add contact wizard with globe pin placement
## Goal
3단계 연락처 추가 위저드.

## Requirements
- Step1: 기본정보 (TanStack Form)
- Step2: 위치 (globeModeAtom=placingPin→역지오코딩→국가/도시)
- Step3: 태그+경력 (Organization 자동완성)

## Notes
- Phase: 3 | ID: W-06 | Priority: P0 | deps: W-03, A-03, A-05"

issue "feat(web/globe): integrate globe-data API with bbox, pins, arcs, clusters, profile card
## Goal
Globe 화면 데이터 연동.

## Requirements
- /globe/data?bbox= TanStack Query
- 핀+아크+클러스터 렌더, 아바타 CORS proxy(next/image)
- 핀 클릭→Drawer/Sheet 프로필카드
- [상세] [관계→/graph?focus=id]

## Notes
- Phase: 3 | ID: W-07 | Priority: P0 | deps: W-03, A-03"

issue "feat(web/settings): profile, tags, export, account deletion
## Goal
Settings 전체 구현.

## Requirements
- /settings/profile/ /tags/ /export/ /account/
- 태그 색상 Popover, CSV 내보내기, 계정삭제 AlertDialog

## Notes
- Phase: 3 | ID: W-08 | Priority: P2 | deps: W-01, W-02, A-04"

issue "feat(web): onboarding flow for first-time users
## Goal
첫 방문 온보딩.

## Requirements
- 첫 실행 감지, 빈 지구본+CTA, 완료 후 미표시

## Notes
- Phase: 3 | ID: W-09 | Priority: P2 | deps: W-02, W-03"

issue "feat(mobile/contacts): list with ListView.builder, infinite scroll, search/filter
## Goal
Flutter 연락처 리스트.

## Requirements
- ListView.builder + 무한스크롤 (Riverpod+Dio)
- SearchAnchor + 정렬 + 태그필터
- 빈 상태, 60fps

## Notes
- Phase: 3 | ID: M-04 | Priority: P0 | deps: M-01, M-02, A-03"

issue "feat(mobile/contacts): detail + 3-step add contact with JS Bridge placingPin
## Goal
Flutter 연락처 상세 + 추가 폼.

## Requirements
- 상세: 프로필/SNS/타임라인/만남/태그
- 추가: 3단계 위저드 (기본→위치 JS Bridge→태그/경력)

## Notes
- Phase: 3 | ID: M-05 | Priority: P1 | deps: M-03, M-04, A-03"

issue "feat(mobile/globe): integrate globe-data API via JS Bridge
## Goal
Flutter Globe 데이터 연동.

## Requirements
- API→JS Bridge 데이터 전달
- 핀/아크/클러스터 렌더
- PIN_TAPPED→프로필 BottomSheet
- iOS 초기 50명 제한

## Notes
- Phase: 3 | ID: M-06 | Priority: P0 | deps: M-03, A-03"

issue "feat(mobile): offline cache with Drift + stale-data banner
## Goal
Flutter 오프라인 캐시.

## Requirements
- Drift 스키마 (연락처+관계)
- connectivity_plus 감지
- 오프라인 캐시 + stale 배너

## Notes
- Phase: 3 | ID: M-07 | Priority: P1 | deps: M-04, M-06"

issue "feat(api/globe): GET /globe/data with bbox PostGIS + Redis caching + ETag
## Goal
Globe 데이터 집계 API.

## Requirements
- GET /globe/data?bbox= PostGIS ST_Within
- contacts[]+relationships[]+clusters[]
- Redis per-user 캐시, mutation 무효화, ETag 304

## Notes
- Phase: 3 | ID: B-01 | Priority: P0 | deps: A-01, A-03"

issue "feat(api): relationship strength auto-recomputation on meeting CRUD
## Goal
미팅 변경 시 관계 strength 자동 재계산.

## Requirements
- Meeting CRUD 시 ContactRelationship.strength 갱신
- globe 캐시 무효화
- strength 0 행 미생성

## Notes
- Phase: 3 | ID: B-02 | Priority: P1 | deps: A-01, A-07"

# ── Phase 4: Graph + Integration ─────────────────────────────────────────────
echo ""
echo "── Phase 4: Graph + Integration ──"

issue "feat(api/graph): edges + clusters API with type filter + Redis cache
## Goal
Graph 데이터 API.

## Requirements
- GET /graph/edges?type=company|school|tag|region|meeting
- GET /graph/clusters?type=
- Redis 캐싱

## Notes
- Phase: 4 | ID: B-03 | Priority: P0 | deps: A-01, A-03, B-02"

issue "feat(web/graph): react-force-graph-2d with filters, layout cache, focus node
## Goal
웹 Graph 뷰.

## Requirements
- react-force-graph-2d (dynamic ssr:false + ErrorBoundary)
- 노드(프사+이름)/엣지(색상+대시 WCAG)
- 필터(nuqs), ?focus=contactId
- localStorage 레이아웃캐시, 빈 상태

## Notes
- Phase: 4 | ID: W-10 | Priority: P0 | deps: W-01, B-03"

issue "feat(web): cross-tab navigation Globe↔Graph with nuqs + fly-to
## Goal
Globe↔Graph 크로스탭 전환.

## Requirements
- Globe→/graph?focus=contactId (nuqs)
- Graph→Globe fly-to (Jotai atom)
- 양방향 전환 애니메이션

## Notes
- Phase: 4 | ID: W-11 | Priority: P1 | deps: W-07, W-10"

issue "feat(mobile/graph): WebView graph + JS Bridge + node tap
## Goal
Flutter Graph 뷰.

## Requirements
- assets/ 번들 graph HTML
- JS Bridge (노드 데이터+탭 이벤트)
- 노드탭→프로필 BottomSheet

## Notes
- Phase: 4 | ID: M-08 | Priority: P0 | deps: M-01, B-03"

issue "feat(mobile): cross-tab Globe↔Graph with StatefulShellRoute
## Goal
Flutter Globe↔Graph 전환.

## Requirements
- StatefulShellRoute.goBranch
- Riverpod globeFocusProvider
- Graph→Globe FLY_TO JS Bridge

## Notes
- Phase: 4 | ID: M-09 | Priority: P1 | deps: M-06, M-08"

issue "feat(web): accessibility — Globe screen reader fallback, WCAG compliance
## Goal
웹 접근성.

## Requirements
- 스크린리더 Globe→리스트뷰 fallback
- 관계선 대시패턴 (WCAG 1.4.1)
- 키보드 네비게이션, 48dp, axe-core 0

## Notes
- Phase: 4 | ID: W-12 | Priority: P1 | deps: W-07, W-10"

issue "feat(mobile): accessibility — TalkBack/VoiceOver, dark mode, Semantics
## Goal
Flutter 접근성.

## Requirements
- Globe fallback (리스트뷰)
- Semantics 라벨 (contact.name)
- 다크모드 JS Bridge SET_THEME

## Notes
- Phase: 4 | ID: M-10 | Priority: P1 | deps: M-06, M-08"

# ── Phase 5: Deploy + QA ─────────────────────────────────────────────────────
echo ""
echo "── Phase 5: Deploy + QA ──"

issue "feat(infra): Terraform GCP modules (Cloud Run + Cloud SQL + Storage + Redis + IAM)
## Goal
GCP 인프라 Terraform.

## Requirements
- modules/: cloud-run, cloud-sql+PostGIS, cloud-storage, redis, iam
- environments/: dev, prod
- GCS backend state

## Notes
- Phase: 5 | ID: I-01 | Priority: P0 | deps: none"

issue "feat(ci/cd): GitHub Actions deploy with OIDC + Cloud Run
## Goal
자동 배포 파이프라인.

## Requirements
- OIDC→GCP Workload Identity
- API Docker→Cloud Run
- Terraform plan(PR)/apply(main)

## Notes
- Phase: 5 | ID: I-02 | Priority: P0 | deps: I-01"

issue "test(e2e): login → add contact → globe → graph core flow
## Goal
핵심 플로우 E2E 테스트.

## Requirements
- Playwright: 로그인→연락처추가→지구본→그래프
- API integration test

## Notes
- Phase: 5 | ID: Q-01 | Priority: P1 | deps: W-11, M-09"

issue "test(perf): Globe 500+ pins, API p95 < 200ms, bundle < 2MB
## Goal
성능 검증.

## Requirements
- Globe 500+ 핀 FPS
- API p95 < 200ms
- 번들 < 2MB gzipped

## Notes
- Phase: 5 | ID: Q-02 | Priority: P1 | deps: W-11, B-01"

issue "test(security): OWASP Top 10 + user-scoping + rate limiting
## Goal
보안 리뷰.

## Requirements
- OWASP Top 10
- cross-user 접근 불가
- presigned URL 검증
- SQLi/XSS

## Notes
- Phase: 5 | ID: Q-03 | Priority: P1 | deps: 전체"

echo ""
echo "✅ All 39 Globe CRM issues created!"
