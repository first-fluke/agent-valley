# Changelog

All notable changes to Agent Valley are documented here. This file is
managed by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) on
`main`. Hand-written release context for each tag lives under
`docs/releases/`.

## [0.3.0](https://github.com/first-fluke/agent-valley/compare/v0.2.0...v0.3.0) (2026-04-22)


### Features

* **cli:** add cloudflare tunnel support with provider abstraction ([ea23989](https://github.com/first-fluke/agent-valley/commit/ea23989397d43e3a0b2fe961d7aa05661115792e))

## [0.2.0](https://github.com/first-fluke/agent-valley/compare/v0.1.0...v0.2.0) (2026-04-22)


### Features

* add CLI login and team dashboard hooks (T6-T7) ([b1a2276](https://github.com/first-fluke/agent-valley/commit/b1a2276c7801f9865f904bb854da3942928ef082))
* add DELIVERY_MODE, non-blocking spawn, auto merge+push, SSE fix ([740509b](https://github.com/first-fluke/agent-valley/commit/740509b0f7309bd02b8c5d769f1d6e37bc14a66d))
* add issue CLI flags, fix orchestrator startup sync and workspace lookup ([4487a5d](https://github.com/first-fluke/agent-valley/commit/4487a5d5f557d319d729126ca3f269c00f696427))
* add replay, Supabase client, EventEmitter, LedgerBridge (T4-T5) ([5b7f069](https://github.com/first-fluke/agent-valley/commit/5b7f069789a268d3d4b68bb4d7425dd5cc293869))
* add team dashboard foundation (T1-T3) ([e444d1a](https://github.com/first-fluke/agent-valley/commit/e444d1a2465a408e9fe925a647bf9692f4932c9c))
* add Todo state config and Linear client mutations ([acad9c1](https://github.com/first-fluke/agent-valley/commit/acad9c11429df8dc9fe8a011a8dacd8923d91390))
* AgentSession abstraction layer ([e4a8e27](https://github.com/first-fluke/agent-valley/commit/e4a8e27589d10128953f74f6aba26a21ecb0bbe3))
* anti-premature-exit retry + safety-net draft PR creation ([cc8d327](https://github.com/first-fluke/agent-valley/commit/cc8d3278426e8ae203c39e6d468327752cb4d30f))
* **budget:** wire recordUsage from agent completion through to BudgetService ([3da1935](https://github.com/first-fluke/agent-valley/commit/3da1935e93b55acfa9176662189ef0ce0ec139f1))
* **cli:** add --scope option to issue command for routing label attachment ([ba9491e](https://github.com/first-fluke/agent-valley/commit/ba9491ea7c4bb23749c2f7f6606c2838af787251))
* **cli:** add av logs and av top commands ([08c3330](https://github.com/first-fluke/agent-valley/commit/08c3330cc92f8d5419d9b1fa981f19bd9ac187e5))
* **cli:** add av up/down daemon lifecycle commands ([a116991](https://github.com/first-fluke/agent-valley/commit/a11699121780cb3d2a8dd81174275df9915e696c))
* **cli:** add interactive setup wizard and CLI entry point ([e64faac](https://github.com/first-fluke/agent-valley/commit/e64faaca000f4e14b5b861dc73731581aec765f6))
* **cli:** add issue command with Claude CLI auto-expansion ([ca6b3d6](https://github.com/first-fluke/agent-valley/commit/ca6b3d67b621ae147be3af38f613d8686e0f339f))
* **cli:** improve setup TUI with step navigation, invite system, and edit mode ([f01e32d](https://github.com/first-fluke/agent-valley/commit/f01e32d38d18c5d3f4c6ac2715698a29a8b673e7))
* **cli:** prepare npm distribution with dual bin commands ([face26a](https://github.com/first-fluke/agent-valley/commit/face26a00de44b90ed7166df466fd409fa7b952a))
* **config:** add SCORING_MODEL and SCORE_ROUTING env vars with Zod validation ([0d2ef77](https://github.com/first-fluke/agent-valley/commit/0d2ef7753f6630e768455ca1c92129ba4c76ad9d))
* **config:** auto-detect MAX_PARALLEL from hardware specs ([c0d2ddd](https://github.com/first-fluke/agent-valley/commit/c0d2ddd8af867f5c06a5b0277d65e6ccdb5c3e15))
* **dashboard:** add AV favicon + web manifest ([2332ee4](https://github.com/first-fluke/agent-valley/commit/2332ee451b22e95bd41163b815faa5b40aa3c391))
* **dashboard:** add coffee cup for agents visiting coffee machine ([302b014](https://github.com/first-fluke/agent-valley/commit/302b01429ed11eff3d53066a796c8c985901798d))
* **dashboard:** add office pets, poop cleanup, L-shaped bathroom ([61db326](https://github.com/first-fluke/agent-valley/commit/61db3261d39e4fedb25bc3696b8dfecac02e54f8))
* **dashboard:** add office puppy + system metrics panel ([6008a32](https://github.com/first-fluke/agent-valley/commit/6008a32c13ce24fb884c1d46d4e9dfdb037a3c11))
* **dashboard:** add pixel art office dashboard with Next.js 16 ([ba4913f](https://github.com/first-fluke/agent-valley/commit/ba4913fe68259c2d42610cc783cf03fd3e231f0e))
* **dashboard:** add team mode UI components (T8) ([6886c9d](https://github.com/first-fluke/agent-valley/commit/6886c9d009ae8208f2c25ff8b4c8b1f0d83ee33a))
* **dashboard:** add waypoint system for bathroom wall-clip prevention ([35654b0](https://github.com/first-fluke/agent-valley/commit/35654b01ac00c54d4176257dbb9ca9748c8d5eac))
* **dashboard:** dynamic office with parallel agents, skins, and wandering ([d765dc0](https://github.com/first-fluke/agent-valley/commit/d765dc006f87d6421d59cf1bd355d091e48b8d2c))
* **dashboard:** integrate real orchestrator with @t3-oss/env-nextjs ([d4010b0](https://github.com/first-fluke/agent-valley/commit/d4010b088c22289f8b5075f241cf8e9a2b1f1133))
* **domain:** add Issue.score field, ScoreAnalysis type, and parseScoreFromLabels ([b53ec80](https://github.com/first-fluke/agent-valley/commit/b53ec8044ccd616d6cbe2b0879c19c28bb9ce01f))
* full issue lifecycle — Todo pickup, Done/Cancelled transitions, comments ([a547d8d](https://github.com/first-fluke/agent-valley/commit/a547d8d7e96dbc8a64d93eee524d8b225f413760))
* harness scripts (dev, gc, validate) ([d792bd6](https://github.com/first-fluke/agent-valley/commit/d792bd60f4f5810e647d1d7102f0e359d29cb034))
* install.sh for new and existing projects ([e6a3828](https://github.com/first-fluke/agent-valley/commit/e6a38284bc012bceee28cfd9daad70b1c03f7f62))
* integrate score routing into orchestrator and CLI ([feb09ad](https://github.com/first-fluke/agent-valley/commit/feb09adf768af6e38f08c4414cdabd689734d434))
* **observability:** add OTel tracing + Prometheus metrics (disabled by default) ([0782d93](https://github.com/first-fluke/agent-valley/commit/0782d93a36d46014f5e937c5285b814c6003b70b))
* oh-my-agent skills and Claude Code sub-agents ([1110e5b](https://github.com/first-fluke/agent-valley/commit/1110e5bb845d96dc759a6fbc2dbb1593c98c0148))
* **orchestrator:** add Budget service with per-issue / per-day caps ([c0d709c](https://github.com/first-fluke/agent-valley/commit/c0d709cbe4c80c268c8eca0faa1f5b9135284a47))
* **orchestrator:** add DAG-based issue dependency scheduling ([867d537](https://github.com/first-fluke/agent-valley/commit/867d53785ea5a469ea40532b5fac8d887674bdf9))
* **orchestrator:** add Live Intervention (pause/resume/abort/append_prompt) ([1811342](https://github.com/first-fluke/agent-valley/commit/1811342f490f67a4ea731499a064c7dcf8b62cb2))
* **orchestrator:** add safety-net auto-commit, instant ack, anti-premature-exit ([2f40118](https://github.com/first-fluke/agent-valley/commit/2f40118a4ec1338c3091f568c75cef4b82d10db0))
* **orchestrator:** add ScoringService, helpers, and resolveRouteWithScore ([e3176c4](https://github.com/first-fluke/agent-valley/commit/e3176c4eda6097cfd467831aa350a346cdb7a3ad))
* Symphony Orchestrator implementation (TypeScript + Bun) ([54c2bc4](https://github.com/first-fluke/agent-valley/commit/54c2bc4ac7781494a8941b8d9fa9dbecefe4d6af))
* **tracker,workspace:** add labels to issue type, support per-route workspace root ([cf6664d](https://github.com/first-fluke/agent-valley/commit/cf6664dcd426dcba29cc187085eb3e52f96a45c3))
* **tracker:** add addIssueLabel with on-demand creation and score label parsing ([939614a](https://github.com/first-fluke/agent-valley/commit/939614aa81b06bcd8813666ca47ac1efdbe00f04))
* **tracker:** add GitHub Issues adapter (IssueTracker + WebhookReceiver) ([04b21cf](https://github.com/first-fluke/agent-valley/commit/04b21cf7bba1cb1409540eacbf780e97b3180df5))
* webhook-driven architecture (replace polling) ([a5ae54a](https://github.com/first-fluke/agent-valley/commit/a5ae54af61da8990c219459f5b6a2e6962d84c6f))
* workflow routing in WORKFLOW.md prompt ([399c2cf](https://github.com/first-fluke/agent-valley/commit/399c2cf0775a7aa603a7e7b193dd2a89d9b8d738))
* **workflow:** enforce related-tests-only + untrusted content defense ([5a6d3cd](https://github.com/first-fluke/agent-valley/commit/5a6d3cd3d0634956e2e29168359fc827387ffb8b))
* **workspace:** auto-resolve merge conflicts with theirs strategy ([86440af](https://github.com/first-fluke/agent-valley/commit/86440af647193e18f45cb30ff7fcc621ae7c7888))


### Bug Fixes

* address /review findings — auth, RLS, pagination, cancelled event ([943a5f7](https://github.com/first-fluke/agent-valley/commit/943a5f71244599abaf9e78f14aea7fdada62af29))
* address REFINE review — dedupe types, fix user_id, add displayName ([3b48ed6](https://github.com/first-fluke/agent-valley/commit/3b48ed6a777393f40ed089eacf274807533fd878))
* cap ClaudeSession output buffer to prevent OOM crash ([816ecd2](https://github.com/first-fluke/agent-valley/commit/816ecd2f584d1f91a5a81d3157186beee9ccd944))
* **ci:** activate Bun + TypeScript CI pipeline ([00be14b](https://github.com/first-fluke/agent-valley/commit/00be14bbcee506147f7e1af8afc1f71e4f1143ac))
* **ci:** move runner.temp to job-level env, add lint-staged + pre-push hook ([2968a42](https://github.com/first-fluke/agent-valley/commit/2968a4257399c099d40f31719c20399be03c3b42))
* **ci:** move runner.temp to step-level env (unavailable at job-level) ([68f1372](https://github.com/first-fluke/agent-valley/commit/68f1372bae47edaf54bdd27cc26b17e519eab4ca))
* **ci:** resolve all typecheck errors, split tsc per workspace ([f342907](https://github.com/first-fluke/agent-valley/commit/f342907dd3f4514593c438b5de8dd20f5799e368))
* **ci:** use marketplace action for oma-update ([e21b0b8](https://github.com/first-fluke/agent-valley/commit/e21b0b869bbaa4489e36861f45118111062f6974))
* **core:** fix av up supervisor restart loop and standalone path resolution ([b1154b2](https://github.com/first-fluke/agent-valley/commit/b1154b26be4aae19dabcb53bd13f1f56f87dc60b))
* **core:** pass env to spawned git processes and add oma update workflow ([f6db6e3](https://github.com/first-fluke/agent-valley/commit/f6db6e39c148fa3d67afc85921cb059241fa32dc))
* **core:** preserve linear mocks under vitest ([429a536](https://github.com/first-fluke/agent-valley/commit/429a536c6796caa8411a55b98b305d98bf79c8b6))
* **core:** prevent .agent-valley metadata from causing merge conflicts ([27a911d](https://github.com/first-fluke/agent-valley/commit/27a911d209a96baa50b473870f0f1f545ff75f3d))
* **core:** resolve 10 production gaps in orchestrator pipeline ([232e715](https://github.com/first-fluke/agent-valley/commit/232e71515d1802f470ff7a41ad743c593d3521de))
* **dashboard:** eliminate SSE connection leak and reduce memory pressure ([990274d](https://github.com/first-fluke/agent-valley/commit/990274d1db5dd449894ee83bd1e022d327ebdb86))
* **dashboard:** harden /api/status and /api/events ([9ce4c92](https://github.com/first-fluke/agent-valley/commit/9ce4c92e40c3a385ef450809024a2779b2c00d0b))
* **dashboard:** remove env-dependent test, tests should be self-contained ([d82e97c](https://github.com/first-fluke/agent-valley/commit/d82e97c71d9976e05c17c7496d1a618e4541e201))
* **dashboard:** remove imageRendering pixelated to fix broken text ([2cfe7dd](https://github.com/first-fluke/agent-valley/commit/2cfe7ddc49a666980dcb39c8d4b204b635896374))
* **dashboard:** replace removed env import with toOrchestratorConfig ([7612638](https://github.com/first-fluke/agent-valley/commit/7612638adbc001211f00383c44aa4264557520ad))
* eliminate session output accumulation + add supervisor self-healing ([452b77f](https://github.com/first-fluke/agent-valley/commit/452b77f24065c4524e0154773bf94ba593b945fc))
* monorepo path resolution — cwd-based ROOT, remove @/ alias from core ([8253e30](https://github.com/first-fluke/agent-valley/commit/8253e302a8f35809450bf82f896bcd18b3383602))
* **orchestrator:** clamp retry backoff exponent for attemptCount=0 ([fb36d1d](https://github.com/first-fluke/agent-valley/commit/fb36d1d3063c5231c6cb044b8700c983116a0fc2))
* **orchestrator:** recover startup sync and routed worktrees ([3052f80](https://github.com/first-fluke/agent-valley/commit/3052f8039d8c50205a9fc0e9cb7eca4a481d43a7))
* **orchestrator:** resolve race conditions, orphan processes, and N+1 queries ([c76436f](https://github.com/first-fluke/agent-valley/commit/c76436f61513e47a72a463779c7f91c6e6d2afae))
* prevent orchestrator errors from crashing dashboard + auto-restart ([e72b4f9](https://github.com/first-fluke/agent-valley/commit/e72b4f9c69abc0ea8b3a5517389f1f747cf15033))
* pull --rebase before merge, retry on push rejection ([695c69e](https://github.com/first-fluke/agent-valley/commit/695c69ee63362d60fff19d8f3cad777fb03b2c63))
* resolve pre-existing lint and validation violations ([65b5c10](https://github.com/first-fluke/agent-valley/commit/65b5c1040c76c05406e7d368782c818462ac2886))
* **security:** sanitize untrusted input in prompts and harden HTTP server ([aa73d4d](https://github.com/first-fluke/agent-valley/commit/aa73d4d5323fbb8ec5f9b143e3abf776e7be36ba))
* **sessions:** add --verbose flag and USER env var for Claude CLI auth ([bdf386d](https://github.com/first-fluke/agent-valley/commit/bdf386dc62084590a5c820af11905be8ecc30059))
* **sessions:** resolve memory leaks, listener cleanup, and module-level state ([dafc77c](https://github.com/first-fluke/agent-valley/commit/dafc77c78d32ca2e2b3bcf50c0748d3033591f6c))
* **skills:** quote backend-agent description ([b27cd2a](https://github.com/first-fluke/agent-valley/commit/b27cd2a11b4e0c16f602f52868b4ecc9639f0ca2))
* standalone static files — symlink .next/static + public into standalone dir ([1c32dae](https://github.com/first-fluke/agent-valley/commit/1c32dae64ce7eec1a76653e29b7eb04bd46601d0))
* **test:** resolve typecheck errors in new test files ([92baa6a](https://github.com/first-fluke/agent-valley/commit/92baa6a42b8024c0832e7fc7589f4d06a9e377aa))
* **test:** update config import path and animation loop assertion ([c0d2ddd](https://github.com/first-fluke/agent-valley/commit/c0d2ddd8af867f5c06a5b0277d65e6ccdb5c3e15))
* **tracker:** add Zod runtime validation, cursor pagination, and config improvements ([deabeed](https://github.com/first-fluke/agent-valley/commit/deabeed3d1e3c87644265dc30de833aa7b28c199))
* **tracker:** fetchIssueByIdentifier and createIssueRelation Linear API bugs ([9d923ed](https://github.com/first-fluke/agent-valley/commit/9d923ed3bd378ab049b753fc30aa7d145c4b9931))
* **tracker:** make Linear mutation errors self-correcting ([c85215b](https://github.com/first-fluke/agent-valley/commit/c85215bf555b463acd2f8de1e80692d4171c820c))
* **workspace:** retry regeneratable lockfile conflicts ([60861a6](https://github.com/first-fluke/agent-valley/commit/60861a61986819939667998dd9bc9c4b1b834626))
* zod/v4 → zod import (v4 is already installed as zod@4.x) ([abca7b3](https://github.com/first-fluke/agent-valley/commit/abca7b312a9aac8438dd580b2eb97b4b5c043060))


### Refactors

* **arch:** move HTTP server startup from Orchestrator to main.ts ([5314942](https://github.com/first-fluke/agent-valley/commit/5314942a711007826c735ef1bae7ca79256876a2))
* **cli:** av dev runs Next.js dashboard + ngrok, remove dead http-server ([f5ec3c8](https://github.com/first-fluke/agent-valley/commit/f5ec3c8e8c5a9565c5c25184423c27b9e1c497ba))
* **cli:** replace all Bun APIs with Node equivalents + clean stale files ([93bddda](https://github.com/first-fluke/agent-valley/commit/93bddda031a4f27fc2eabf2fc8347ace1ebb3456))
* **config:** rename config.ts to env.ts ([b404faf](https://github.com/first-fluke/agent-valley/commit/b404faf5ee535daa14c3cf75bf3fe7e295cadf28))
* **config:** split .env into global settings.yaml + project valley.yaml ([444a01b](https://github.com/first-fluke/agent-valley/commit/444a01baadbe9d6cb0dbaf74a8a7bd195d05cd6c))
* conventional branch naming + .agent-valley metadata dir ([0c7e3ac](https://github.com/first-fluke/agent-valley/commit/0c7e3ace3cab02f835d5f33506e67b390551c703))
* **core:** introduce domain ports and DI seam for tracker/webhook/workspace ([de4d395](https://github.com/first-fluke/agent-valley/commit/de4d395c601b28cad2be4c0d8072e719ffc9d8e3))
* **core:** replace Bun.spawn with node:child_process in scoring-service ([aa3b08c](https://github.com/first-fluke/agent-valley/commit/aa3b08c734ed88a06bdd11ca8bb9f24aee44420c))
* **domain:** promote ParsedWebhookEvent to domain + introduce AgentRunnerPort ([760e6c0](https://github.com/first-fluke/agent-valley/commit/760e6c093ed808c3dd15d08a7f167264515bf029))
* eliminate all lint warnings with type-safe guards ([71cf925](https://github.com/first-fluke/agent-valley/commit/71cf925e535f470bc0859cbeb612d520f2d64a98))
* **orchestrator:** split Orchestrator into core/lifecycle/router modules ([a773d17](https://github.com/first-fluke/agent-valley/commit/a773d1731a0a99445d3262786a4180f598901ab7))
* replace Bun-specific APIs with Node.js standard equivalents ([de7546c](https://github.com/first-fluke/agent-valley/commit/de7546cef7acaf709984fa2901dd5f5a2ac6a5a2))
* restructure into Bun workspace monorepo (apps/ + packages/) ([1cc0e34](https://github.com/first-fluke/agent-valley/commit/1cc0e34a08846959f3586664bf917489123f5df2))
* **workspace:** rebase-based merge delivery instead of --theirs ([3ccb992](https://github.com/first-fluke/agent-valley/commit/3ccb9928e1715057f0025e0ea11aa676455b36d9))
* **workspace:** split WorkspaceManager into worktree/delivery/safety-net modules ([91d2c73](https://github.com/first-fluke/agent-valley/commit/91d2c73dec15a02fb313773d131ca5d9ba3628b3))


### Performance

* av up builds standalone + runs production server ([78220dc](https://github.com/first-fluke/agent-valley/commit/78220dc2205ad952c392bae9991f033154f5d645))


### Documentation

* add integration tests, CHANGELOG, and v0.2 documentation ([a82a209](https://github.com/first-fluke/agent-valley/commit/a82a209734208c4f70f85f3089019c54650e5b84))
* add issue creation rules and version-check step to WORKFLOW.md ([0830985](https://github.com/first-fluke/agent-valley/commit/0830985db5305add247b4d03d9db6ee8470a7ade))
* add product requirements document v0.1 ([b5143fd](https://github.com/first-fluke/agent-valley/commit/b5143fd081b87400271be5ccd8d2b48f704861a1))
* **architecture:** add review artifact with prioritized findings ([5b9a01c](https://github.com/first-fluke/agent-valley/commit/5b9a01c022a17a2d7fb2e3a725005319d8419d1f))
* clarify new project setup flow ([2a051cd](https://github.com/first-fluke/agent-valley/commit/2a051cd1f0ddf6c2e158f37661c0edc9200ee2aa))
* **claude:** correct paths to monorepo layout ([9242c58](https://github.com/first-fluke/agent-valley/commit/9242c58b502eebdc5f229c660e93ba3620d65ca6))
* **guides:** document SYMPHONY_DASHBOARD_TOKEN and SYMPHONY_ALLOW_REMOTE_STATUS ([f77a395](https://github.com/first-fluke/agent-valley/commit/f77a3958b5176a5a1515d145331778587b3fd51b))
* project documentation (AGENTS, README, AGENT_SETUP) ([4b4e49d](https://github.com/first-fluke/agent-valley/commit/4b4e49db950d752b8c9128e9743b3cf053316fb1))
* Symphony SPEC and architecture documentation ([0096044](https://github.com/first-fluke/agent-valley/commit/0096044fba58d702f8cfc9d42d1394df6df044a6))
* translate all documentation to English ([9b09fec](https://github.com/first-fluke/agent-valley/commit/9b09fec561e3508ca1f0471576c98c60487d405e))
* update all docs for issue lifecycle flow ([2f74b1f](https://github.com/first-fluke/agent-valley/commit/2f74b1fcc8b19fafdeb7530b3ad1fb4f0d8f7138))
* update README product name to agent-valley, license to AGPL-3.0 ([2332a2c](https://github.com/first-fluke/agent-valley/commit/2332a2c956decc39b02d7cd3b2960600c8cdae46))
* update README to reflect current monorepo implementation ([51f3e34](https://github.com/first-fluke/agent-valley/commit/51f3e3465d2f30c454d0e99bebbeac4941dbacd8))


### Tests

* add ClaudeSession streaming tests (output, OOM, events, cap) ([76a75e4](https://github.com/first-fluke/agent-valley/commit/76a75e46ebddbccff00d0d4d7edffcbefce8594a))
* add coverage gate (lines 80% / branches 70%) to validate.sh ([3edb151](https://github.com/first-fluke/agent-valley/commit/3edb151e50a46402e14d1a37dd8dd1e994f8f791))
* add regression tests for SSE connection leak and metrics caching ([106a4a0](https://github.com/first-fluke/agent-valley/commit/106a4a0c37de49be948def31cf799a057a27a08a))
* add score routing tests and design document ([db30291](https://github.com/first-fluke/agent-valley/commit/db3029136b55bee5d64274e9d1985972196a0ee8))
* add unit and integration tests (99 tests, 0→100% core coverage) ([7df235c](https://github.com/first-fluke/agent-valley/commit/7df235cebcf290aa21167ff58c61c3a4b9965630))
* **core:** add characterization suites for orchestrator and workspace-manager ([2e8664c](https://github.com/first-fluke/agent-valley/commit/2e8664c74877250865658185c1df57f24dcfe07c))
* **core:** increase unit test coverage to 86% (from 77%) ([202fffb](https://github.com/first-fluke/agent-valley/commit/202fffb81a3593f585399a06c4a2572ccfff7cab))
* **core:** relax flaky completion retry timeout ([0190fb3](https://github.com/first-fluke/agent-valley/commit/0190fb3fb0d339e033e4be483ca58cbcceb04bf5))
* update CLI and dashboard tests for YAML config ([fdfdd38](https://github.com/first-fluke/agent-valley/commit/fdfdd383c64f8b9da9c21fb331e93f395e19a894))
* update office-layout tests for bathroom bump dimensions ([ba7e48c](https://github.com/first-fluke/agent-valley/commit/ba7e48cd2b2497946a0a5aeb4b8db3321221e325))


### Chores

* **release:** drop bump-patch-for-minor-pre-major so feat bumps minor ([bbc7467](https://github.com/first-fluke/agent-valley/commit/bbc74670459ecdb441e6129336fc9f3313af9dfe))

## [0.1.0] - 2026-04

Initial release. Linear tracker + Claude / Codex / Gemini agents + retry
queue + DAG scheduler + multi-repo routing + score-based routing + team
dashboard beta.
