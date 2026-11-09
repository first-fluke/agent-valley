# Changelog

All notable changes to Agent Valley are documented here. This file is
managed by [release-please](https://github.com/googleapis/release-please)
from [Conventional Commits](https://www.conventionalcommits.org/) on
`main`. Hand-written release context for each tag lives under
`docs/releases/`.

## [4.9.8](https://github.com/first-fluke/agent-valley/compare/v4.9.7...v4.9.8) (2026-11-09)


### Bug Fixes

* **chief:** allow up to 48 tasks in long supervised missions ([de44345](https://github.com/first-fluke/agent-valley/commit/de4434560fb1630617c5f36ca9a066b40c4ac1eb))

## [4.9.7](https://github.com/first-fluke/agent-valley/compare/v4.9.6...v4.9.7) (2026-11-09)


### Bug Fixes

* **cli:** honor --duration before pinning an expired mission deadline ([a91291c](https://github.com/first-fluke/agent-valley/commit/a91291c9ff722113674795461f9375be349ea3b7))

## [4.9.6](https://github.com/first-fluke/agent-valley/compare/v4.9.5...v4.9.6) (2026-11-09)


### Bug Fixes

* **chief:** allow up to 40 acceptance criteria per task ([131b299](https://github.com/first-fluke/agent-valley/commit/131b299304a231a8b523a2b4dd663de555cf6dbc))

## [4.9.5](https://github.com/first-fluke/agent-valley/compare/v4.9.4...v4.9.5) (2026-11-09)


### Tests

* **chief:** remove POSIX-only process-group tests for a zero-skip suite ([33a8a78](https://github.com/first-fluke/agent-valley/commit/33a8a787d0ad8feb23c7088aeb1f1272ea37f264))

## [4.9.4](https://github.com/first-fluke/agent-valley/compare/v4.9.3...v4.9.4) (2026-11-09)


### Tests

* **chief:** run windows symlink and subprocess coverage instead of skipping ([4ceb408](https://github.com/first-fluke/agent-valley/commit/4ceb408cd061314ad1ca3b749aba50240289bf22))

## [4.9.3](https://github.com/first-fluke/agent-valley/compare/v4.9.2...v4.9.3) (2026-11-09)


### Bug Fixes

* **chief:** allow up to 24 tasks in plans and replans ([4959a63](https://github.com/first-fluke/agent-valley/commit/4959a6322798d452b0319f34311867114da505de))

## [4.9.2](https://github.com/first-fluke/agent-valley/compare/v4.9.1...v4.9.2) (2026-11-09)


### Bug Fixes

* **chief:** cover windows capability gaps in retention and tests ([50fc7f0](https://github.com/first-fluke/agent-valley/commit/50fc7f0e05e831f2c001315fa0525da8f6ca88b6))

## [4.9.1](https://github.com/first-fluke/agent-valley/compare/v4.9.0...v4.9.1) (2026-11-09)


### Bug Fixes

* **chief:** do not cool a route after a framework attempt deadline ([8441d32](https://github.com/first-fluke/agent-valley/commit/8441d32c2868cbc8d5bb6d199e97f047acfebcf1))

## [4.9.0](https://github.com/first-fluke/agent-valley/compare/v4.8.8...v4.9.0) (2026-11-09)


### Features

* **agents:** add native provider sessions and runtime fixes ([882497e](https://github.com/first-fluke/agent-valley/commit/882497e47f382b4ad47efc2a6df159454fcb5faa))
* **chief:** amend a saved operating charter on resume ([c03cc4c](https://github.com/first-fluke/agent-valley/commit/c03cc4c238c3d640e89dfb70b6712af03321024f))
* **chief:** keep accepted tasks through a replan with retain flags ([870f20c](https://github.com/first-fluke/agent-valley/commit/870f20cf701c9cce167f22e418cd67e1af105f73))
* **chief:** preserve sibling tasks, sync source baseline and add freellm ([5407787](https://github.com/first-fluke/agent-valley/commit/5407787398756093cf9e1b798af2169b05f4e51e))
* **chief:** record operator notes on mission resume ([a4eb2ad](https://github.com/first-fluke/agent-valley/commit/a4eb2adc574a0dfdf9e69b2880310b53e552259a))
* **chief:** supply the integrated change set to independent reviews ([779f2bb](https://github.com/first-fluke/agent-valley/commit/779f2bbba5d321dfc3dd5607ee4fbd86710a88d4))
* **orchestrator:** add dead-letter queue, disk persistence, and ttl expiration purge ([c288924](https://github.com/first-fluke/agent-valley/commit/c28892420a3b37316ae7cd6ac32857322cea903e))
* **sessions:** add windows os sandbox support via powershell isolation ([a64b748](https://github.com/first-fluke/agent-valley/commit/a64b7485449d57288d1c683b450d2f24c6f986ca))


### Bug Fixes

* **chief:** accept supervision decisions above the former 8,000-character cutoff ([17e3080](https://github.com/first-fluke/agent-valley/commit/17e3080ad996b348167cbd0191591a573b44b620))
* **chief:** do not count an attempt deadline as provider failure; allow --timeout on resume ([f0ac35a](https://github.com/first-fluke/agent-valley/commit/f0ac35ab652e648a255922b50f75579d981e1ab3))
* **chief:** drop a rejected delivery's changeSet before direct repairs ([b7f57e6](https://github.com/first-fluke/agent-valley/commit/b7f57e6be74096415c75249a7430b95c765a0aa2))
* **chief:** hand off to a healthy vendor and wait on cooldowns otherwise ([d759f03](https://github.com/first-fluke/agent-valley/commit/d759f0352bae155f3d005c38e7d43f8463744e5f))
* **chief:** keep completed tasks completed across targeted repairs ([92abb3e](https://github.com/first-fluke/agent-valley/commit/92abb3ecfa1ef942ceb8a8a18731b5fbeacc303c))
* **chief:** keep exhausted-provider review handoffs healthy and on-roster ([fc1e14c](https://github.com/first-fluke/agent-valley/commit/fc1e14cb5194f6f532ec985987af0e7072cf709e))
* **chief:** keep intentional untracking in the accepted baseline snapshot ([743043f](https://github.com/first-fluke/agent-valley/commit/743043f0e965a446e53f951fd180314d24f36d44))
* **chief:** keep literal Git pathspecs out of test-runner verification checks ([42d5be3](https://github.com/first-fluke/agent-valley/commit/42d5be397ef014227f0f102b7ca6ffac194497fd))
* **chief:** keep scoped final-review repairs re-executing named tasks ([9eaeb49](https://github.com/first-fluke/agent-valley/commit/9eaeb4991ee7537954d0091feb47fd9b61ae2322))
* **chief:** observe newer mission records and ignore actor config migrations ([de607d5](https://github.com/first-fluke/agent-valley/commit/de607d5e0001c1753e7d7d05465c0fdbffad421e))
* **chief:** parse json responses wrapped in prose ([1fb4f94](https://github.com/first-fluke/agent-valley/commit/1fb4f9462c3914b3b5b7cd017786381531be029e))
* **chief:** preserve parallel actor revision evidence for review ([292b44a](https://github.com/first-fluke/agent-valley/commit/292b44ab5e8d7aa7a4ac78f2dc88869e88a2218f))
* **chief:** raise default per-attempt timeout to 3600 seconds ([3e52391](https://github.com/first-fluke/agent-valley/commit/3e523914cb4da7791c8f52e291b9df1a88e4d7a6))
* **chief:** raise the Git output buffer for large verified cycles ([b1599f2](https://github.com/first-fluke/agent-valley/commit/b1599f268887ce3311dc7b6e3d150c49b15a9d67))
* **chief:** raise the per-cycle source product path ceiling to 5,000 ([b0ce4e9](https://github.com/first-fluke/agent-valley/commit/b0ce4e933547d31cc5602eb3303dd97a829e91bd))
* **chief:** re-isolate repairs of rejected isolated deliveries ([3d58994](https://github.com/first-fluke/agent-valley/commit/3d589949565e45302f4cf4528114738e9db8c246))
* **chief:** re-pin a clean fast-forward at source integration time too ([4351937](https://github.com/first-fluke/agent-valley/commit/43519377f67d27d89033ebe7833d0dbe5a956cb2))
* **chief:** re-pin worktree integration after a clean fast-forward ([42b5466](https://github.com/first-fluke/agent-valley/commit/42b5466d8c8f9dd4608abacb4e8db7de289368a9))
* **chief:** re-review delivered tasks after worktree drift instead of re-running them ([0495e47](https://github.com/first-fluke/agent-valley/commit/0495e470240a5754da1078802af27ac6afa163e9))
* **chief:** reject rosters whose skills no installed agent profile declares ([b8dbe58](https://github.com/first-fluke/agent-valley/commit/b8dbe5868cae22993c8c32d6516f1922492bf1e8))
* **chief:** repair complete json responses before schema validation ([92cfbc1](https://github.com/first-fluke/agent-valley/commit/92cfbc18c2317c599acd8320d017eb71bcfee53a))
* **chief:** repair cycle blockers in provenance, recovery and routing ([84be5a0](https://github.com/first-fluke/agent-valley/commit/84be5a075fae243151038b10eff7172fcdf2aaef))
* **chief:** repair on the only configured route without a Chief decision ([1587117](https://github.com/first-fluke/agent-valley/commit/1587117d850038a2a6b4b98874900f08a99ccd01))
* **chief:** retry and reroute a configured reviewer that returns no verdict ([9239d0f](https://github.com/first-fluke/agent-valley/commit/9239d0ffd1d5125e0863d510d9fbfe30c46be4d0))
* **chief:** run contract checks under the operator per-check timeout ([4fbea15](https://github.com/first-fluke/agent-valley/commit/4fbea15e0c6b63d00c3753121218be8691258b67))
* **chief:** scope final-review repairs to the tasks the findings name ([285b1af](https://github.com/first-fluke/agent-valley/commit/285b1af1e7a548e290632c2f679d8597e47ede04))
* **chief:** scope QA task acceptance to evidence rather than defect absence ([fe9d13e](https://github.com/first-fluke/agent-valley/commit/fe9d13eb6a8ad9ff0ad727b243935380930b6378))
* **chief:** share an in-flight provider handoff across concurrent reviews ([fb6afb8](https://github.com/first-fluke/agent-valley/commit/fb6afb8f19587e3c76127ae0cc668553d1216173))
* **chief:** share the 5,000 product path ceiling with the integration receipt ([d67aaec](https://github.com/first-fluke/agent-valley/commit/d67aaecd19524b53af509fb1f67104bb71eb7d3d))
* **chief:** skip staged-then-deleted paths in the parallel baseline ([a2d42ea](https://github.com/first-fluke/agent-valley/commit/a2d42eafecb3123a694104dedf44c5848cb49a76))
* **chief:** state the verification check timeout in the supervision prompt too ([b6e4355](https://github.com/first-fluke/agent-valley/commit/b6e4355a7718d32720bde58b8b98b837acc2da20))
* **chief:** stop final reviews from inventing deployment-target and object prerequisites ([7d2d6c9](https://github.com/first-fluke/agent-valley/commit/7d2d6c9db2df102c28864a43c7947d8d39920f13))
* **chief:** tell Actors and the Chief the real verification check timeout ([00e2378](https://github.com/first-fluke/agent-valley/commit/00e2378fe1848422c42047da5a6815d7230b48f1))
* **chief:** treat a mission's own tooling limits as repairable, not fixed ([76407fe](https://github.com/first-fluke/agent-valley/commit/76407fe9bd5672d826c1296e27815912eaf3f2b3))
* **chief:** window route evidence and degrade instead of failing routing ([a9b0aa4](https://github.com/first-fluke/agent-valley/commit/a9b0aa4d37d5d9cb666b686738178ced37cd0c09))
* **core:** preserve native responses and harden structured parsing ([dd31d18](https://github.com/first-fluke/agent-valley/commit/dd31d18ff3fc3ea380f883ef0589a0342eb45801))
* **sessions:** allow opencode's loopback session server inside the sandbox ([712a655](https://github.com/first-fluke/agent-valley/commit/712a65542ccd28286179ce8d145784354754f410))
* **sessions:** allow shared tmp writes and pseudo-tty in actor sandbox ([9a88495](https://github.com/first-fluke/agent-valley/commit/9a884956cb1a9886e91acf4a2f72d25354e526c0))
* **sessions:** allow TCP listeners for every sandboxed actor ([b71348d](https://github.com/first-fluke/agent-valley/commit/b71348d34de7476e701ad6abbbbd53ef43cf1c24))
* **sessions:** grant pty slave devices so sandboxed actors can open a terminal ([a71bb4b](https://github.com/first-fluke/agent-valley/commit/a71bb4b1f1b477ed1171c9dda0420e3477a626cc))
* **sessions:** let sandboxed actors write Cargo, rustup and mise homes ([74ab5c7](https://github.com/first-fluke/agent-valley/commit/74ab5c7d156a05b3ffb57112613a5c4ff5a46f83))
* **sessions:** only require local powershell binary in windows sandbox tests when running on win32 ([75ae169](https://github.com/first-fluke/agent-valley/commit/75ae1698983f3c9f45a6031e9013d0c77494d052))


### Refactors

* **core:** share bounded native result accumulation ([40918c9](https://github.com/first-fluke/agent-valley/commit/40918c9f7346ca98ff9a02910d6295ce13453a21))
* **harness:** decompose files over 500-line cap to satisfy validate.sh Check 4/5 ([ea63340](https://github.com/first-fluke/agent-valley/commit/ea6334005990e27c985acc6332de2b79f1c34dd4))


### Performance

* **chief:** keep task review prompts within argv-delivered CLI limits ([9292ebe](https://github.com/first-fluke/agent-valley/commit/9292ebed0c4f0924389eca53b50abfb2cde219ed))
* **chief:** review integrated tasks concurrently within maxParallel ([c234288](https://github.com/first-fluke/agent-valley/commit/c23428883e929b69b7276c173105841867175261))


### Tests

* **chief:** cover the fast-forward re-pin at source integration time ([5905bf5](https://github.com/first-fluke/agent-valley/commit/5905bf5a9800042b7309a59e7d80fd46467b04e4))
* **chief:** pin the clock in legacy timeout reservation fixtures ([768a55a](https://github.com/first-fluke/agent-valley/commit/768a55a0c916e117cc1b819ec119a9b20049424d))

## [4.8.8](https://github.com/first-fluke/agent-valley/compare/v4.8.7...v4.8.8) (2026-11-06)


### Bug Fixes

* **chief:** align planning responses with the shared json limit ([a9cebe7](https://github.com/first-fluke/agent-valley/commit/a9cebe788e537d24326efd3c8a192c03940c780f))

## [4.8.7](https://github.com/first-fluke/agent-valley/compare/v4.8.6...v4.8.7) (2026-11-06)


### Bug Fixes

* **dev:** preserve exact push scope and native node checks ([591a4a5](https://github.com/first-fluke/agent-valley/commit/591a4a5ea603ac2f17b0c17b037139a9157dc5bd))
* **dev:** replace husky with scoped hk hooks ([62de647](https://github.com/first-fluke/agent-valley/commit/62de6476239860b360df1e8ba80b9b172ffdb4ff))
* **setup:** retain caller identity and handle unsupported auth probes ([f148bd6](https://github.com/first-fluke/agent-valley/commit/f148bd6154d0e26b82737c9a348639b96ad96de3))

## [4.8.6](https://github.com/first-fluke/agent-valley/compare/v4.8.5...v4.8.6) (2026-11-06)


### Bug Fixes

* **chief:** back off failing actors and avoid interactive stalls ([15f3550](https://github.com/first-fluke/agent-valley/commit/15f3550ae08108542ec2df2c7b33a941fc77311f))


### Tests

* **cli:** harden worker readiness and cleanup fixtures ([cdcbc01](https://github.com/first-fluke/agent-valley/commit/cdcbc01582ef4fd419d5ccc06e20ca041ae219c3))

## [4.8.5](https://github.com/first-fluke/agent-valley/compare/v4.8.4...v4.8.5) (2026-11-06)


### Bug Fixes

* **chief:** preserve spent retry budgets on resume ([2663c1e](https://github.com/first-fluke/agent-valley/commit/2663c1e3a36b430b774edaa9e088e3eee673d4f9))
* **sandbox:** allow scoped Unix listeners on macOS ([ea749bb](https://github.com/first-fluke/agent-valley/commit/ea749bbf9147deaf9f466b216ee337fd9967da64))

## [4.8.4](https://github.com/first-fluke/agent-valley/compare/v4.8.3...v4.8.4) (2026-11-06)


### Bug Fixes

* **chief:** decompose independent work by module boundaries ([c83c47a](https://github.com/first-fluke/agent-valley/commit/c83c47ae1e65ffaa908b767157bf1ed0d28ac520))

## [4.8.3](https://github.com/first-fluke/agent-valley/compare/v4.8.2...v4.8.3) (2026-11-06)


### Tests

* **config:** align integration with OMA trigger policy ([8926ca8](https://github.com/first-fluke/agent-valley/commit/8926ca89646c4c3d658d7572d5deb72e025b6ff6))

## [4.8.2](https://github.com/first-fluke/agent-valley/compare/v4.8.1...v4.8.2) (2026-11-06)


### Bug Fixes

* **chief:** continue bounded work when routing quality drops ([d644ce8](https://github.com/first-fluke/agent-valley/commit/d644ce884abbfefb23a1530925ad448b2fca80af))

## [4.8.1](https://github.com/first-fluke/agent-valley/compare/v4.8.0...v4.8.1) (2026-11-06)


### Bug Fixes

* **chief:** preserve routes after operator interruption ([c17c1d1](https://github.com/first-fluke/agent-valley/commit/c17c1d1b2329883753157a49daf118c4ee75020d))

## [4.8.0](https://github.com/first-fluke/agent-valley/compare/v4.7.0...v4.8.0) (2026-11-06)


### Features

* **chief:** apply verified cycles to source before continuing ([eb14eba](https://github.com/first-fluke/agent-valley/commit/eb14eba91ded8a7c0a34d2c7ce77b7fe56f9cd17))


### Bug Fixes

* **chief:** preserve saved orders during source handoff ([0501add](https://github.com/first-fluke/agent-valley/commit/0501add756f7b39ad07a53e96ae28600c21b89ff))


### Refactors

* **chief:** share continuous operation port definitions ([8dd59de](https://github.com/first-fluke/agent-valley/commit/8dd59debc87c102ce6f068a8e98a1b7c40460357))

## [4.7.0](https://github.com/first-fluke/agent-valley/compare/v4.6.0...v4.7.0) (2026-11-06)


### Features

* **chief:** hand off exhausted agents to authenticated providers ([8c0cfa8](https://github.com/first-fluke/agent-valley/commit/8c0cfa89c566290eeaed2e850bb08e1baf6dc227))
* **delivery:** follow up on GitHub reviews for any issue tracker ([83c5af6](https://github.com/first-fluke/agent-valley/commit/83c5af68751e2c6b612f1174617738dc4548ae90))
* **state:** keep orchestrator state in one SQLite database ([76b5313](https://github.com/first-fluke/agent-valley/commit/76b5313a5f83c9507d2f339d85535eed4fc606af))


### Bug Fixes

* **chief:** recover planning timeouts and reconnect child orders ([da7d7b0](https://github.com/first-fluke/agent-valley/commit/da7d7b0a3482fab98bc9b4d10dfed4a271ea619d))
* **chief:** recover unavailable models without replaying work ([002e93f](https://github.com/first-fluke/agent-valley/commit/002e93fb8d43a0f43d70fed423428859f2f32e4e))
* **config:** keep honoring github.comment_relay.pull_request_reviews ([dcc5a80](https://github.com/first-fluke/agent-valley/commit/dcc5a809cf3a8967cc91efb20bfce88806b3b709))
* **executions:** validate A2A storage before ignore updates ([7eb1d89](https://github.com/first-fluke/agent-valley/commit/7eb1d89e851e0cf347a0b1f45fbb9f3c07bc703d))
* **grok:** preserve final JSON decisions across native runs ([922aae5](https://github.com/first-fluke/agent-valley/commit/922aae54dea5a6fcd215a3f9c85b7bdf1142afa3))
* **setup:** ignore runtime state before project startup ([a81d892](https://github.com/first-fluke/agent-valley/commit/a81d892d418dd14a7d0d986bc2321802ce65e237))

## [4.6.0](https://github.com/first-fluke/agent-valley/compare/v4.5.0...v4.6.0) (2026-11-02)


### Features

* **tracker:** follow up on pull request reviews of delivered work ([39a7209](https://github.com/first-fluke/agent-valley/commit/39a7209af0f21682170bf44e07c5cbf06050cb23))


### Bug Fixes

* **prompt:** keep retry context when the template omits it ([609084d](https://github.com/first-fluke/agent-valley/commit/609084d13669a289d0ee9d7d91931b6105c61588))

## [4.5.0](https://github.com/first-fluke/agent-valley/compare/v4.4.0...v4.5.0) (2026-11-02)


### Features

* **tracker:** relay Linear issue comments to running actors ([95ac744](https://github.com/first-fluke/agent-valley/commit/95ac744095c73bda6f7016ccae23291e0427c1dd))

## [4.4.0](https://github.com/first-fluke/agent-valley/compare/v4.3.0...v4.4.0) (2026-11-02)


### Features

* **tracker:** relay maintainer issue comments to running actors ([4eeef49](https://github.com/first-fluke/agent-valley/commit/4eeef49c288ae61656bb7dd427742edcc40dc4ba))

## [4.3.0](https://github.com/first-fluke/agent-valley/compare/v4.2.1...v4.3.0) (2026-10-30)


### Features

* **cli:** expose machine-readable mission status ([0e1f6e9](https://github.com/first-fluke/agent-valley/commit/0e1f6e9099bb149004b6b62bf53e4072144a061c))


### Bug Fixes

* **dev:** check markdown before unattended delivery ([3325f48](https://github.com/first-fluke/agent-valley/commit/3325f480f371713fabd622e9f8a8838e16e0b5d3))

## [4.2.1](https://github.com/first-fluke/agent-valley/compare/v4.2.0...v4.2.1) (2026-10-30)


### Bug Fixes

* **chief:** resume service-owned work after OS shutdown ([0642bd6](https://github.com/first-fluke/agent-valley/commit/0642bd6fa29bbb923c6abdb5a30bdee961f6d8eb))

## [4.2.0](https://github.com/first-fluke/agent-valley/compare/v4.1.0...v4.2.0) (2026-10-30)


### Features

* **chief:** pin operator pre-push policy for unattended delivery ([ed964c3](https://github.com/first-fluke/agent-valley/commit/ed964c334dc0ceddff5da362c1937da61e8fb299))

## [4.1.0](https://github.com/first-fluke/agent-valley/compare/v4.0.1...v4.1.0) (2026-10-30)


### Features

* **chief:** supervise and deliver verified orders unattended ([50081f9](https://github.com/first-fluke/agent-valley/commit/50081f93ac69aad8dbeb6923cf2f3fe194a45fe7))


### Bug Fixes

* **chief:** bound malformed planning response recovery ([a5c5d94](https://github.com/first-fluke/agent-valley/commit/a5c5d94dc64adf4cfa675d34e9258902d096c07e))
* **chief:** enforce mission deadlines while awaiting workers ([b3b0d59](https://github.com/first-fluke/agent-valley/commit/b3b0d59bd6f2a635ad4d8ffcabe8910747c2e7fc))
* **chief:** finalize verified work without another actor ([7e27c45](https://github.com/first-fluke/agent-valley/commit/7e27c4599ba3cfbb581e243f74b263261e96d6b2))
* **chief:** import source bases for continuing delivery ([8a66b7c](https://github.com/first-fluke/agent-valley/commit/8a66b7c21e35cd71f5871c9baa5405ef4c4f2237))
* **chief:** preserve completed missions after elapsed deadlines ([db5d6d6](https://github.com/first-fluke/agent-valley/commit/db5d6d6c0fc79c963075ce785f946c2c069200d9))
* **workspace:** separate repository and mission destination ([e9098d1](https://github.com/first-fluke/agent-valley/commit/e9098d1c8a7f8571a3c51c028ec23c2b1ad93639))


### Tests

* **chief:** allow filesystem load in maximum capture delivery ([f4641d5](https://github.com/first-fluke/agent-valley/commit/f4641d53ced0ca5ec1f486230ea2f6736b9a8795))

## [4.0.1](https://github.com/first-fluke/agent-valley/compare/v4.0.0...v4.0.1) (2026-10-30)


### ⚠ BREAKING CHANGES

* **team:** team configuration uses relay_url and turso_url. Supabase sessions must be replaced by AV user tokens.
* av order and av_order now continue improving by default. Use --once or once:true for the former single-goal behavior. MCP default submission returns operationId; av_operate is replaced by av_order.
* **chief:** Project configuration is read only from av.yaml. Rename existing valley.yaml files to av.yaml before running AV.

### Features

* add CLI login and team dashboard hooks (T6-T7) ([b1a2276](https://github.com/first-fluke/agent-valley/commit/b1a2276c7801f9865f904bb854da3942928ef082))
* add DELIVERY_MODE, non-blocking spawn, auto merge+push, SSE fix ([740509b](https://github.com/first-fluke/agent-valley/commit/740509b0f7309bd02b8c5d769f1d6e37bc14a66d))
* add issue CLI flags, fix orchestrator startup sync and workspace lookup ([4487a5d](https://github.com/first-fluke/agent-valley/commit/4487a5d5f557d319d729126ca3f269c00f696427))
* add replay, Supabase client, EventEmitter, LedgerBridge (T4-T5) ([5b7f069](https://github.com/first-fluke/agent-valley/commit/5b7f069789a268d3d4b68bb4d7425dd5cc293869))
* add team dashboard foundation (T1-T3) ([e444d1a](https://github.com/first-fluke/agent-valley/commit/e444d1a2465a408e9fe925a647bf9692f4932c9c))
* add Todo state config and Linear client mutations ([acad9c1](https://github.com/first-fluke/agent-valley/commit/acad9c11429df8dc9fe8a011a8dacd8923d91390))
* address assessment findings across runtime and dashboard ([de66920](https://github.com/first-fluke/agent-valley/commit/de66920cc747694493f2eeab993b9966103e6fc3))
* AgentSession abstraction layer ([e4a8e27](https://github.com/first-fluke/agent-valley/commit/e4a8e27589d10128953f74f6aba26a21ecb0bbe3))
* anti-premature-exit retry + safety-net draft PR creation ([cc8d327](https://github.com/first-fluke/agent-valley/commit/cc8d3278426e8ae203c39e6d468327752cb4d30f))
* **budget:** wire recordUsage from agent completion through to BudgetService ([3da1935](https://github.com/first-fluke/agent-valley/commit/3da1935e93b55acfa9176662189ef0ce0ec139f1))
* **chief:** add durable goal coordination and verification ([1dfe7cc](https://github.com/first-fluke/agent-valley/commit/1dfe7ccf66d419985a1a32d1f17ad00fdc2a25c8))
* **chief:** automate verified missions with director teams ([7aa1ae7](https://github.com/first-fluke/agent-valley/commit/7aa1ae7fb0959270b35e7c33d101ae148210e816))
* **chief:** orchestrate missions and review gates with LangGraph ([1f5b085](https://github.com/first-fluke/agent-valley/commit/1f5b0854d1868e803571b670d2ae6e7a6139721f))
* **cli:** add --scope option to issue command for routing label attachment ([ba9491e](https://github.com/first-fluke/agent-valley/commit/ba9491ea7c4bb23749c2f7f6606c2838af787251))
* **cli:** add av logs and av top commands ([08c3330](https://github.com/first-fluke/agent-valley/commit/08c3330cc92f8d5419d9b1fa981f19bd9ac187e5))
* **cli:** add av up/down daemon lifecycle commands ([a116991](https://github.com/first-fluke/agent-valley/commit/a11699121780cb3d2a8dd81174275df9915e696c))
* **cli:** add cloudflare tunnel support with provider abstraction ([ea23989](https://github.com/first-fluke/agent-valley/commit/ea23989397d43e3a0b2fe961d7aa05661115792e))
* **cli:** add interactive setup wizard and CLI entry point ([e64faac](https://github.com/first-fluke/agent-valley/commit/e64faaca000f4e14b5b861dc73731581aec765f6))
* **cli:** add issue command with Claude CLI auto-expansion ([ca6b3d6](https://github.com/first-fluke/agent-valley/commit/ca6b3d67b621ae147be3af38f613d8686e0f339f))
* **cli:** auto-register linear webhook and add av doctor ([958bfad](https://github.com/first-fluke/agent-valley/commit/958bfad29d055e9dc9c8120df79b3f90cdb8f7e9))
* **clients:** add durable MCP missions and native plugin exports ([d905d5b](https://github.com/first-fluke/agent-valley/commit/d905d5b32b3757ed1065daf94e9043b3a3267a26))
* **cli:** improve setup TUI with step navigation, invite system, and edit mode ([f01e32d](https://github.com/first-fluke/agent-valley/commit/f01e32d38d18c5d3f4c6ac2715698a29a8b673e7))
* **cli:** prepare npm distribution with dual bin commands ([face26a](https://github.com/first-fluke/agent-valley/commit/face26a00de44b90ed7166df466fd409fa7b952a))
* **config:** add SCORING_MODEL and SCORE_ROUTING env vars with Zod validation ([0d2ef77](https://github.com/first-fluke/agent-valley/commit/0d2ef7753f6630e768455ca1c92129ba4c76ad9d))
* **config:** auto-detect MAX_PARALLEL from hardware specs ([c0d2ddd](https://github.com/first-fluke/agent-valley/commit/c0d2ddd8af867f5c06a5b0277d65e6ccdb5c3e15))
* **config:** auto-route issues to oma workflows and inject guidance ([2b57cd4](https://github.com/first-fluke/agent-valley/commit/2b57cd460c739d5d13182b4c17ee9f9061625764))
* **config:** wire max_parallel and add verify_command schema ([f33e331](https://github.com/first-fluke/agent-valley/commit/f33e331980940711c7cafea24b80f4154683d968))
* **dashboard:** add AV favicon + web manifest ([2332ee4](https://github.com/first-fluke/agent-valley/commit/2332ee451b22e95bd41163b815faa5b40aa3c391))
* **dashboard:** add coffee cup for agents visiting coffee machine ([302b014](https://github.com/first-fluke/agent-valley/commit/302b01429ed11eff3d53066a796c8c985901798d))
* **dashboard:** add office pets, poop cleanup, L-shaped bathroom ([61db326](https://github.com/first-fluke/agent-valley/commit/61db3261d39e4fedb25bc3696b8dfecac02e54f8))
* **dashboard:** add office puppy + system metrics panel ([6008a32](https://github.com/first-fluke/agent-valley/commit/6008a32c13ce24fb884c1d46d4e9dfdb037a3c11))
* **dashboard:** add pixel art office dashboard with Next.js 16 ([ba4913f](https://github.com/first-fluke/agent-valley/commit/ba4913fe68259c2d42610cc783cf03fd3e231f0e))
* **dashboard:** add team mode UI components (T8) ([6886c9d](https://github.com/first-fluke/agent-valley/commit/6886c9d009ae8208f2c25ff8b4c8b1f0d83ee33a))
* **dashboard:** add waypoint system for bathroom wall-clip prevention ([35654b0](https://github.com/first-fluke/agent-valley/commit/35654b01ac00c54d4176257dbb9ca9748c8d5eac))
* **dashboard:** bearer-token auth and mounted intervention ui ([2593d89](https://github.com/first-fluke/agent-valley/commit/2593d89a82d4c1366528c33efa7215035faec459))
* **dashboard:** dynamic office with parallel agents, skins, and wandering ([d765dc0](https://github.com/first-fluke/agent-valley/commit/d765dc006f87d6421d59cf1bd355d091e48b8d2c))
* **dashboard:** integrate real orchestrator with @t3-oss/env-nextjs ([d4010b0](https://github.com/first-fluke/agent-valley/commit/d4010b088c22289f8b5075f241cf8e9a2b1f1133))
* **domain:** add Issue.score field, ScoreAnalysis type, and parseScoreFromLabels ([b53ec80](https://github.com/first-fluke/agent-valley/commit/b53ec8044ccd616d6cbe2b0879c19c28bb9ce01f))
* full issue lifecycle — Todo pickup, Done/Cancelled transitions, comments ([a547d8d](https://github.com/first-fluke/agent-valley/commit/a547d8d7e96dbc8a64d93eee524d8b225f413760))
* harness scripts (dev, gc, validate) ([d792bd6](https://github.com/first-fluke/agent-valley/commit/d792bd60f4f5810e647d1d7102f0e359d29cb034))
* install.sh for new and existing projects ([e6a3828](https://github.com/first-fluke/agent-valley/commit/e6a38284bc012bceee28cfd9daad70b1c03f7f62))
* integrate score routing into orchestrator and CLI ([feb09ad](https://github.com/first-fluke/agent-valley/commit/feb09adf768af6e38f08c4414cdabd689734d434))
* make order the continuous chief entry point ([7ac8405](https://github.com/first-fluke/agent-valley/commit/7ac8405f0900a344006e7aaba772a892eb646183))
* make the Chief own strategy and autonomous execution ([dc3945a](https://github.com/first-fluke/agent-valley/commit/dc3945a66cc5e19564d3f1de53f5928b60ce9ff5))
* **observability:** add OTel tracing + Prometheus metrics (disabled by default) ([0782d93](https://github.com/first-fluke/agent-valley/commit/0782d93a36d46014f5e937c5285b814c6003b70b))
* **observability:** budget persistence, otel genai, ledger relay ([77d8702](https://github.com/first-fluke/agent-valley/commit/77d87029b348d9f07e4f077e01da7826945679d6))
* oh-my-agent skills and Claude Code sub-agents ([1110e5b](https://github.com/first-fluke/agent-valley/commit/1110e5bb845d96dc759a6fbc2dbb1593c98c0148))
* **oma:** gate work actors with cached skill audits ([f2b619a](https://github.com/first-fluke/agent-valley/commit/f2b619a0d2c00d303e63605bb1d95e5a91f72dd0))
* **orchestrator:** add Budget service with per-issue / per-day caps ([c0d709c](https://github.com/first-fluke/agent-valley/commit/c0d709cbe4c80c268c8eca0faa1f5b9135284a47))
* **orchestrator:** add DAG-based issue dependency scheduling ([867d537](https://github.com/first-fluke/agent-valley/commit/867d53785ea5a469ea40532b5fac8d887674bdf9))
* **orchestrator:** add Live Intervention (pause/resume/abort/append_prompt) ([1811342](https://github.com/first-fluke/agent-valley/commit/1811342f490f67a4ea731499a064c7dcf8b62cb2))
* **orchestrator:** add safety-net auto-commit, instant ack, anti-premature-exit ([2f40118](https://github.com/first-fluke/agent-valley/commit/2f40118a4ec1338c3091f568c75cef4b82d10db0))
* **orchestrator:** add ScoringService, helpers, and resolveRouteWithScore ([e3176c4](https://github.com/first-fluke/agent-valley/commit/e3176c4eda6097cfd467831aa350a346cdb7a3ad))
* **orchestrator:** thread agent pid for crash-recovery reattach ([414258d](https://github.com/first-fluke/agent-valley/commit/414258d5d2c455a68308695fc06983c01638acbb))
* **orchestrator:** verification gate security hardening & prompt injection defense ([14aae00](https://github.com/first-fluke/agent-valley/commit/14aae0007d3c846172145d59b3fe65d8f53f923f))
* **orchestrator:** verification gate, crash recovery, classified retry ([38af8ff](https://github.com/first-fluke/agent-valley/commit/38af8ffdd93e8beb62e150ed6abf0f4f34804b56))
* **qwen:** add native chief and actor support ([a607968](https://github.com/first-fluke/agent-valley/commit/a607968e4af7b0ab7b1827e1218ef800b67f060e))
* **runtime:** add durable A2A execution and operator recovery ([84d5849](https://github.com/first-fluke/agent-valley/commit/84d5849abeef8054793118bc844fe5012c9f1dfd))
* **security:** sandbox credential isolation and injection spotlighting ([8632373](https://github.com/first-fluke/agent-valley/commit/8632373c8d904ea58677d6532fec0398bdb1babc))
* **sessions:** add kimi (moonshot) as a supported vendor ([d0f8966](https://github.com/first-fluke/agent-valley/commit/d0f896620be0b97c13c3fbfcfe3f9b8cc1ab34fa))
* **sessions:** add opencode as a supported vendor ([c828d6b](https://github.com/first-fluke/agent-valley/commit/c828d6b83b9278fcacae9644ff6f199a0a26007b))
* **sessions:** os sandbox isolation with fail-closed default ([4bc17cc](https://github.com/first-fluke/agent-valley/commit/4bc17cca0446669e1b62ae9070a87c5cc6219b69))
* **sessions:** replace gemini with antigravity, cursor, grok adapters ([b11e8bc](https://github.com/first-fluke/agent-valley/commit/b11e8bcce03dc9a24d6088e7c8e703318069c35b))
* **setup:** preserve initiating agent in unattended installation ([1e95da0](https://github.com/first-fluke/agent-valley/commit/1e95da03fa6044d6793cd03cac2c3c8916cdec12))
* supervise container failures and verify service recovery ([f294799](https://github.com/first-fluke/agent-valley/commit/f294799993c99b8f9e77bce78a86cc0375684f63))
* supervise continuous chief improvement operations ([e05e511](https://github.com/first-fluke/agent-valley/commit/e05e511176fb74667cf21c7787c846c90a003bb8))
* Symphony Orchestrator implementation (TypeScript + Bun) ([54c2bc4](https://github.com/first-fluke/agent-valley/commit/54c2bc4ac7781494a8941b8d9fa9dbecefe4d6af))
* **team:** replace Supabase with Turso and Drizzle ([b5327fa](https://github.com/first-fluke/agent-valley/commit/b5327fabb6724d42b35bf084aab9dddfbed444d3))
* **tracker,workspace:** add labels to issue type, support per-route workspace root ([cf6664d](https://github.com/first-fluke/agent-valley/commit/cf6664dcd426dcba29cc187085eb3e52f96a45c3))
* **tracker:** add addIssueLabel with on-demand creation and score label parsing ([939614a](https://github.com/first-fluke/agent-valley/commit/939614aa81b06bcd8813666ca47ac1efdbe00f04))
* **tracker:** add GitHub Issues adapter (IssueTracker + WebhookReceiver) ([04b21cf](https://github.com/first-fluke/agent-valley/commit/04b21cf7bba1cb1409540eacbf780e97b3180df5))
* **tracker:** thread github delivery-id for precise webhook dedup ([1d60037](https://github.com/first-fluke/agent-valley/commit/1d60037b2cab05628ddcdd3d28225d761109f18b))
* **tracker:** timing-safe hmac and webhook replay dedup ([87a49b3](https://github.com/first-fluke/agent-valley/commit/87a49b3a5db848216d62785b0591db9c05da92fc))
* webhook-driven architecture (replace polling) ([a5ae54a](https://github.com/first-fluke/agent-valley/commit/a5ae54af61da8990c219459f5b6a2e6962d84c6f))
* workflow routing in WORKFLOW.md prompt ([399c2cf](https://github.com/first-fluke/agent-valley/commit/399c2cf0775a7aa603a7e7b193dd2a89d9b8d738))
* **workflow:** enforce related-tests-only + untrusted content defense ([5a6d3cd](https://github.com/first-fluke/agent-valley/commit/5a6d3cd3d0634956e2e29168359fc827387ffb8b))
* **workspace:** auto-resolve merge conflicts with theirs strategy ([86440af](https://github.com/first-fluke/agent-valley/commit/86440af647193e18f45cb30ff7fcc621ae7c7888))


### Bug Fixes

* **a2a:** close cancellation and recovery gaps ([76bcfbc](https://github.com/first-fluke/agent-valley/commit/76bcfbc0194e6dad2d9899e9626c1e1d81812c99))
* address /review findings — auth, RLS, pagination, cancelled event ([943a5f7](https://github.com/first-fluke/agent-valley/commit/943a5f71244599abaf9e78f14aea7fdada62af29))
* address REFINE review — dedupe types, fix user_id, add displayName ([3b48ed6](https://github.com/first-fluke/agent-valley/commit/3b48ed6a777393f40ed089eacf274807533fd878))
* align node package checks with chief outcome reports ([e28cab8](https://github.com/first-fluke/agent-valley/commit/e28cab8b8c3496219da53395aa29203f25e97f0d))
* await result handlers during shutdown ([e0849cf](https://github.com/first-fluke/agent-valley/commit/e0849cf0e463965556ab287fff766397cce1ac70))
* cap ClaudeSession output buffer to prevent OOM crash ([816ecd2](https://github.com/first-fluke/agent-valley/commit/816ecd2f584d1f91a5a81d3157186beee9ccd944))
* **chief:** assign installed skills to fixed actors ([e122771](https://github.com/first-fluke/agent-valley/commit/e122771f454d9608377c50844e83b553a597a00e))
* **chief:** declare canonical task response fields ([e032c17](https://github.com/first-fluke/agent-valley/commit/e032c17ad20114884dfc034dae9acf2d0e8c8ce1))
* **chief:** preserve execution outcomes and join runtime cleanup ([4a2c30a](https://github.com/first-fluke/agent-valley/commit/4a2c30aef1729d26a1630dbaa78721acb9188e7e))
* **chief:** separate planning response from mission metadata ([9161822](https://github.com/first-fluke/agent-valley/commit/91618225dbb2caa6440dcc84151e7d88c9448028))
* **chief:** specify review response contracts ([4cf15db](https://github.com/first-fluke/agent-valley/commit/4cf15dbf48375c4a08d2583eac09b656f6da901d))
* **ci:** activate Bun + TypeScript CI pipeline ([00be14b](https://github.com/first-fluke/agent-valley/commit/00be14bbcee506147f7e1af8afc1f71e4f1143ac))
* **ci:** make A2A deadline checks deterministic ([7777b6f](https://github.com/first-fluke/agent-valley/commit/7777b6ff8691572914e5677d52c1fd22b5256984))
* **ci:** move runner.temp to job-level env, add lint-staged + pre-push hook ([2968a42](https://github.com/first-fluke/agent-valley/commit/2968a4257399c099d40f31719c20399be03c3b42))
* **ci:** move runner.temp to step-level env (unavailable at job-level) ([68f1372](https://github.com/first-fluke/agent-valley/commit/68f1372bae47edaf54bdd27cc26b17e519eab4ca))
* **ci:** preserve generated changelog formatting ([7d0857c](https://github.com/first-fluke/agent-valley/commit/7d0857ca31323d45377593a58f3bab6bd193e272))
* **ci:** resolve all typecheck errors, split tsc per workspace ([f342907](https://github.com/first-fluke/agent-valley/commit/f342907dd3f4514593c438b5de8dd20f5799e368))
* **ci:** satisfy runtime size and timeout checks ([aeae032](https://github.com/first-fluke/agent-valley/commit/aeae0320a19deb5c71bf757285bc46333125042c))
* **ci:** use marketplace action for oma-update ([e21b0b8](https://github.com/first-fluke/agent-valley/commit/e21b0b869bbaa4489e36861f45118111062f6974))
* **ci:** validate native CLI runtime dependencies ([cbaa4c5](https://github.com/first-fluke/agent-valley/commit/cbaa4c526745b550ffc8c131c8c33ff301d0a31f))
* **cli:** report mission outcomes with accurate exit codes ([d5f58d2](https://github.com/first-fluke/agent-valley/commit/d5f58d28a262000ae5458cba07061ea9bf7aa5d1))
* **codex:** delegate tools to enforced macOS sandbox ([4ed3468](https://github.com/first-fluke/agent-valley/commit/4ed34687060e99eb79df93a21375fe42ff6f3df3))
* **codex:** select completed final answers ([2af9ad2](https://github.com/first-fluke/agent-valley/commit/2af9ad2ef33e2d5d1da02bfa6ee5b0518d3f3a68))
* **config:** reduce workflow-routing false positives ([55a9806](https://github.com/first-fluke/agent-valley/commit/55a9806599574fca864c4956d8ef40b856bf31a7))
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
* **install:** preserve OMA settings and pin source releases ([dd80c5a](https://github.com/first-fluke/agent-valley/commit/dd80c5ab5a118a42424ce09ffc9d8c948c6546a4))
* monorepo path resolution — cwd-based ROOT, remove @/ alias from core ([8253e30](https://github.com/first-fluke/agent-valley/commit/8253e302a8f35809450bf82f896bcd18b3383602))
* **oma:** update to 17 and support centralized receipts ([68606b4](https://github.com/first-fluke/agent-valley/commit/68606b44956593b745ccbe47049b0e53608b2b77))
* **oma:** use latest CLI with strict receipt validation ([e6dc158](https://github.com/first-fluke/agent-valley/commit/e6dc15821b26d473459a42c825f36ffc24d790a9))
* **oma:** verify strict receipt support for CLI 15.0.15 ([c5bc558](https://github.com/first-fluke/agent-valley/commit/c5bc5580f2ef2658e36a7bb431b250a9b3350b53))
* **orchestrator:** clamp retry backoff exponent for attemptCount=0 ([fb36d1d](https://github.com/first-fluke/agent-valley/commit/fb36d1d3063c5231c6cb044b8700c983116a0fc2))
* **orchestrator:** forward explicit env overrides to the verify child ([a1138d9](https://github.com/first-fluke/agent-valley/commit/a1138d97e2db3b47a5242cfb564b8f3b840b6544))
* **orchestrator:** recover startup sync and routed worktrees ([3052f80](https://github.com/first-fluke/agent-valley/commit/3052f8039d8c50205a9fc0e9cb7eca4a481d43a7))
* **orchestrator:** resolve race conditions, orphan processes, and N+1 queries ([c76436f](https://github.com/first-fluke/agent-valley/commit/c76436f61513e47a72a463779c7f91c6e6d2afae))
* **plugins:** include licenses in distributed packages ([febb07a](https://github.com/first-fluke/agent-valley/commit/febb07a1a966df33d496ca51dcaac4bd15a11877))
* preserve linux workspace identity and isolate test fixtures ([acd7c2a](https://github.com/first-fluke/agent-valley/commit/acd7c2afbe79da2b4920c76ee0b39de676575647))
* prevent orchestrator errors from crashing dashboard + auto-restart ([e72b4f9](https://github.com/first-fluke/agent-valley/commit/e72b4f9c69abc0ea8b3a5517389f1f747cf15033))
* pull --rebase before merge, retry on push rejection ([695c69e](https://github.com/first-fluke/agent-valley/commit/695c69ee63362d60fff19d8f3cad777fb03b2c63))
* **release:** publish standalone Node packages with aligned versions ([9b0c466](https://github.com/first-fluke/agent-valley/commit/9b0c466c05b69516d5b7a74b2070bc0e5d897d12))
* **release:** reject version regressions before merging ([26c35d5](https://github.com/first-fluke/agent-valley/commit/26c35d5148cc4f6cddd72f5441b6154423856779))
* repair installation and agent farm lifecycle ([6ef27b1](https://github.com/first-fluke/agent-valley/commit/6ef27b1fe6bbecfc2d05615ab2e7801c34b81936))
* resolve pre-existing lint and validation violations ([65b5c10](https://github.com/first-fluke/agent-valley/commit/65b5c1040c76c05406e7d368782c818462ac2886))
* **runtime:** join Codex shutdown before confirming cleanup ([2a18358](https://github.com/first-fluke/agent-valley/commit/2a18358d0472a36755a65c51d268d341f84b4b23))
* **runtime:** verify stale handle cleanup failures ([e22fe28](https://github.com/first-fluke/agent-valley/commit/e22fe288bcbda7cf0e061641307ed74c424947df))
* **runtime:** wait for retired process groups after EPERM ([095ea50](https://github.com/first-fluke/agent-valley/commit/095ea50cc35ab3ae54cfb01a4759242a9fe7b823))
* **sandbox:** allow signals within the agent sandbox ([037dbd6](https://github.com/first-fluke/agent-valley/commit/037dbd6968a930776e78bb539e301e29720b82c6))
* **sandbox:** protect canonical project config paths ([79428a9](https://github.com/first-fluke/agent-valley/commit/79428a9a752f6bc0764726eafef14abd38703975))
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
* **verification:** bound and sanitize streamed check output ([1c1b5e5](https://github.com/first-fluke/agent-valley/commit/1c1b5e590e78d5493437ee94335bf6f3a2aa3648))
* **workspace:** non-destructive merge-conflict resolution ([8d45efd](https://github.com/first-fluke/agent-valley/commit/8d45efdf769b198a206ac6f633ed8c2487b4ee41))
* **workspace:** retry regeneratable lockfile conflicts ([60861a6](https://github.com/first-fluke/agent-valley/commit/60861a61986819939667998dd9bc9c4b1b834626))
* zod/v4 → zod import (v4 is already installed as zod@4.x) ([abca7b3](https://github.com/first-fluke/agent-valley/commit/abca7b312a9aac8438dd580b2eb97b4b5c043060))


### Refactors

* **arch:** move HTTP server startup from Orchestrator to main.ts ([5314942](https://github.com/first-fluke/agent-valley/commit/5314942a711007826c735ef1bae7ca79256876a2))
* **chief:** avoid the actor skill type dependency cycle ([2a606b1](https://github.com/first-fluke/agent-valley/commit/2a606b18f2e4a96dba72ddc956f7ce2a6a384817))
* **cli:** av dev runs Next.js dashboard + ngrok, remove dead http-server ([f5ec3c8](https://github.com/first-fluke/agent-valley/commit/f5ec3c8e8c5a9565c5c25184423c27b9e1c497ba))
* **cli:** replace all Bun APIs with Node equivalents + clean stale files ([93bddda](https://github.com/first-fluke/agent-valley/commit/93bddda031a4f27fc2eabf2fc8347ace1ebb3456))
* **config:** rename config.ts to env.ts ([b404faf](https://github.com/first-fluke/agent-valley/commit/b404faf5ee535daa14c3cf75bf3fe7e295cadf28))
* **config:** split .env into global settings.yaml + project valley.yaml ([444a01b](https://github.com/first-fluke/agent-valley/commit/444a01baadbe9d6cb0dbaf74a8a7bd195d05cd6c))
* conventional branch naming + .agent-valley metadata dir ([0c7e3ac](https://github.com/first-fluke/agent-valley/commit/0c7e3ace3cab02f835d5f33506e67b390551c703))
* **core:** introduce domain ports and DI seam for tracker/webhook/workspace ([de4d395](https://github.com/first-fluke/agent-valley/commit/de4d395c601b28cad2be4c0d8072e719ffc9d8e3))
* **core:** replace Bun.spawn with node:child_process in scoring-service ([aa3b08c](https://github.com/first-fluke/agent-valley/commit/aa3b08c734ed88a06bdd11ca8bb9f24aee44420c))
* **domain:** promote ParsedWebhookEvent to domain + introduce AgentRunnerPort ([760e6c0](https://github.com/first-fluke/agent-valley/commit/760e6c093ed808c3dd15d08a7f167264515bf029))
* eliminate all lint warnings with type-safe guards ([71cf925](https://github.com/first-fluke/agent-valley/commit/71cf925e535f470bc0859cbeb612d520f2d64a98))
* harden orchestration and enforce quality gates ([f213d15](https://github.com/first-fluke/agent-valley/commit/f213d150678ec6480c5a6b95c77d24f278919730))
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
* clarify chief autonomy and token usage ([27caf90](https://github.com/first-fluke/agent-valley/commit/27caf9034c2b5d8153f68417bf756390e0ece5a7))
* clarify new project setup flow ([2a051cd](https://github.com/first-fluke/agent-valley/commit/2a051cd1f0ddf6c2e158f37661c0edc9200ee2aa))
* **claude:** correct paths to monorepo layout ([9242c58](https://github.com/first-fluke/agent-valley/commit/9242c58b502eebdc5f229c660e93ba3620d65ca6))
* document new config, env vars, and updated specs ([6812d61](https://github.com/first-fluke/agent-valley/commit/6812d61f001e0a80ee9a25cfb41ca8f10bf16979))
* **guides:** document SYMPHONY_DASHBOARD_TOKEN and SYMPHONY_ALLOW_REMOTE_STATUS ([f77a395](https://github.com/first-fluke/agent-valley/commit/f77a3958b5176a5a1515d145331778587b3fd51b))
* preserve model selection in chief autonomy guidance ([8b6b20a](https://github.com/first-fluke/agent-valley/commit/8b6b20a181b6e934c60d72d01414f848bc889091))
* project documentation (AGENTS, README, AGENT_SETUP) ([4b4e49d](https://github.com/first-fluke/agent-valley/commit/4b4e49db950d752b8c9128e9743b3cf053316fb1))
* record supervised operation and release acceptance ([6d86cae](https://github.com/first-fluke/agent-valley/commit/6d86caeae61546ffc7deb2267f1d331b26bd3912))
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
* **chief:** allow parallel director completion order ([029199d](https://github.com/first-fluke/agent-valley/commit/029199dbce7e6c2ff93cbcbdd95d6a0e8b53c642))
* **core:** add characterization suites for orchestrator and workspace-manager ([2e8664c](https://github.com/first-fluke/agent-valley/commit/2e8664c74877250865658185c1df57f24dcfe07c))
* **core:** increase unit test coverage to 86% (from 77%) ([202fffb](https://github.com/first-fluke/agent-valley/commit/202fffb81a3593f585399a06c4a2572ccfff7cab))
* **core:** relax flaky completion retry timeout ([0190fb3](https://github.com/first-fluke/agent-valley/commit/0190fb3fb0d339e033e4be483ca58cbcceb04bf5))
* **dashboard:** stabilize the operations hook harness ([13efca6](https://github.com/first-fluke/agent-valley/commit/13efca658eb0c1ed2fa6e31b3a779fca69c83f71))
* **installer:** use the probed python for pty fixtures ([4e64175](https://github.com/first-fluke/agent-valley/commit/4e641750851287da0b37cc2e1a3b428139c5c39b))
* stabilize process integration deadlines and cleanup ([e56d05f](https://github.com/first-fluke/agent-valley/commit/e56d05faebcf85e309e2e5a38677b510c94f43c8))
* update CLI and dashboard tests for YAML config ([fdfdd38](https://github.com/first-fluke/agent-valley/commit/fdfdd383c64f8b9da9c21fb331e93f395e19a894))
* update office-layout tests for bathroom bump dimensions ([ba7e48c](https://github.com/first-fluke/agent-valley/commit/ba7e48cd2b2497946a0a5aeb4b8db3321221e325))


### Chores

* **release:** drop bump-patch-for-minor-pre-major so feat bumps minor ([bbc7467](https://github.com/first-fluke/agent-valley/commit/bbc74670459ecdb441e6129336fc9f3313af9dfe))
* **release:** prepare version 1.0.0 ([e237251](https://github.com/first-fluke/agent-valley/commit/e237251c2fdbc4f920af9482728befce7c054496))

## [4.0.0](https://github.com/first-fluke/agent-valley/compare/v3.0.5...v4.0.0) (2026-10-28)

### Breaking Changes

- **orchestrator:** verification gate security hardening & prompt injection defense
- **deps:** major dependency update (Biome v2.6.3, Bun types v1.4.4, Commitlint v21.2.4)

### Features

- **orchestrator:** Verification gate security hardening (`buildVerifyEnv` secret-leak isolation, `stripAnsi` control sequence stripping, `sanitizeVerbatim` prompt injection defense, timeout sec clamp)

## [3.0.5](https://github.com/first-fluke/agent-valley/compare/v3.0.4...v3.0.5) (2026-10-28)

### Bug Fixes

- **runtime:** wait for retired process groups after EPERM ([095ea50](https://github.com/first-fluke/agent-valley/commit/095ea50cc35ab3ae54cfb01a4759242a9fe7b823))

## [3.0.4](https://github.com/first-fluke/agent-valley/compare/v3.0.3...v3.0.4) (2026-10-28)

### Bug Fixes

- **chief:** separate planning response from mission metadata ([9161822](https://github.com/first-fluke/agent-valley/commit/91618225dbb2caa6440dcc84151e7d88c9448028))

## [3.0.3](https://github.com/first-fluke/agent-valley/compare/v3.0.2...v3.0.3) (2026-10-28)

### Bug Fixes

- **ci:** satisfy runtime size and timeout checks ([aeae032](https://github.com/first-fluke/agent-valley/commit/aeae0320a19deb5c71bf757285bc46333125042c))
- **runtime:** join Codex shutdown before confirming cleanup ([2a18358](https://github.com/first-fluke/agent-valley/commit/2a18358d0472a36755a65c51d268d341f84b4b23))

## [3.0.2](https://github.com/first-fluke/agent-valley/compare/v3.0.1...v3.0.2) (2026-10-23)

### Bug Fixes

- **runtime:** verify stale handle cleanup failures ([e22fe28](https://github.com/first-fluke/agent-valley/commit/e22fe288bcbda7cf0e061641307ed74c424947df))
- **sandbox:** allow signals within the agent sandbox ([037dbd6](https://github.com/first-fluke/agent-valley/commit/037dbd6968a930776e78bb539e301e29720b82c6))


### Tests

- stabilize process integration deadlines and cleanup ([e56d05f](https://github.com/first-fluke/agent-valley/commit/e56d05faebcf85e309e2e5a38677b510c94f43c8))

## [3.0.1](https://github.com/first-fluke/agent-valley/compare/v3.0.0...v3.0.1) (2026-10-23)

### Bug Fixes

- **chief:** specify review response contracts ([4cf15db](https://github.com/first-fluke/agent-valley/commit/4cf15dbf48375c4a08d2583eac09b656f6da901d))
- **codex:** delegate tools to enforced macOS sandbox ([4ed3468](https://github.com/first-fluke/agent-valley/commit/4ed34687060e99eb79df93a21375fe42ff6f3df3))
- **sandbox:** protect canonical project config paths ([79428a9](https://github.com/first-fluke/agent-valley/commit/79428a9a752f6bc0764726eafef14abd38703975))

## [3.0.0](https://github.com/first-fluke/agent-valley/compare/v2.3.1...v3.0.0) (2026-10-23)

### ⚠ BREAKING CHANGES

- **team:** team configuration uses relay_url and turso_url. Supabase sessions must be replaced by AV user tokens.

### Features

- **chief:** orchestrate missions and review gates with LangGraph ([1f5b085](https://github.com/first-fluke/agent-valley/commit/1f5b0854d1868e803571b670d2ae6e7a6139721f))
- **runtime:** add durable A2A execution and operator recovery ([84d5849](https://github.com/first-fluke/agent-valley/commit/84d5849abeef8054793118bc844fe5012c9f1dfd))
- **team:** replace Supabase with Turso and Drizzle ([b5327fa](https://github.com/first-fluke/agent-valley/commit/b5327fabb6724d42b35bf084aab9dddfbed444d3))


### Bug Fixes

- **a2a:** close cancellation and recovery gaps ([76bcfbc](https://github.com/first-fluke/agent-valley/commit/76bcfbc0194e6dad2d9899e9626c1e1d81812c99))
- **chief:** preserve execution outcomes and join runtime cleanup ([4a2c30a](https://github.com/first-fluke/agent-valley/commit/4a2c30aef1729d26a1630dbaa78721acb9188e7e))
- **ci:** make A2A deadline checks deterministic ([7777b6f](https://github.com/first-fluke/agent-valley/commit/7777b6ff8691572914e5677d52c1fd22b5256984))
- **ci:** validate native CLI runtime dependencies ([cbaa4c5](https://github.com/first-fluke/agent-valley/commit/cbaa4c526745b550ffc8c131c8c33ff301d0a31f))
- **codex:** select completed final answers ([2af9ad2](https://github.com/first-fluke/agent-valley/commit/2af9ad2ef33e2d5d1da02bfa6ee5b0518d3f3a68))


### Refactors

- harden orchestration and enforce quality gates ([f213d15](https://github.com/first-fluke/agent-valley/commit/f213d150678ec6480c5a6b95c77d24f278919730))

## [2.3.1](https://github.com/first-fluke/agent-valley/compare/v2.3.0...v2.3.1) (2026-10-09)

### Bug Fixes

- **oma:** update to 17 and support centralized receipts ([68606b4](https://github.com/first-fluke/agent-valley/commit/68606b44956593b745ccbe47049b0e53608b2b77))


### Tests

- **installer:** use the probed python for pty fixtures ([4e64175](https://github.com/first-fluke/agent-valley/commit/4e641750851287da0b37cc2e1a3b428139c5c39b))

## [2.3.0](https://github.com/first-fluke/agent-valley/compare/v2.2.1...v2.3.0) (2026-10-07)

### Features

- **oma:** gate work actors with cached skill audits ([f2b619a](https://github.com/first-fluke/agent-valley/commit/f2b619a0d2c00d303e63605bb1d95e5a91f72dd0))

## [2.2.1](https://github.com/first-fluke/agent-valley/compare/v2.2.0...v2.2.1) (2026-10-06)

### Bug Fixes

- **oma:** use latest CLI with strict receipt validation ([e6dc158](https://github.com/first-fluke/agent-valley/commit/e6dc15821b26d473459a42c825f36ffc24d790a9))

## [2.2.0](https://github.com/first-fluke/agent-valley/compare/v2.1.0...v2.2.0) (2026-10-06)

### Features

- make the Chief own strategy and autonomous execution ([dc3945a](https://github.com/first-fluke/agent-valley/commit/dc3945a66cc5e19564d3f1de53f5928b60ce9ff5))


### Bug Fixes

- align node package checks with chief outcome reports ([e28cab8](https://github.com/first-fluke/agent-valley/commit/e28cab8b8c3496219da53395aa29203f25e97f0d))

## [2.1.0](https://github.com/first-fluke/agent-valley/compare/v2.0.0...v2.1.0) (2026-10-05)

### Features

- supervise container failures and verify service recovery ([f294799](https://github.com/first-fluke/agent-valley/commit/f294799993c99b8f9e77bce78a86cc0375684f63))

## [2.0.0](https://github.com/first-fluke/agent-valley/compare/v1.1.0...v2.0.0) (2026-10-05)

### ⚠ BREAKING CHANGES

- av order and av_order now continue improving by default. Use --once or once:true for the former single-goal behavior. MCP default submission returns operationId; av_operate is replaced by av_order.

### Features

- make order the continuous chief entry point ([7ac8405](https://github.com/first-fluke/agent-valley/commit/7ac8405f0900a344006e7aaba772a892eb646183))

## [1.1.0](https://github.com/first-fluke/agent-valley/compare/v1.0.1...v1.1.0) (2026-10-05)

### Features

- supervise continuous chief improvement operations ([e05e511](https://github.com/first-fluke/agent-valley/commit/e05e511176fb74667cf21c7787c846c90a003bb8))

## [1.0.1](https://github.com/first-fluke/agent-valley/compare/v1.0.0...v1.0.1) (2026-10-05)

### Documentation

- clarify chief autonomy and token usage ([27caf90](https://github.com/first-fluke/agent-valley/commit/27caf9034c2b5d8153f68417bf756390e0ece5a7))
- preserve model selection in chief autonomy guidance ([8b6b20a](https://github.com/first-fluke/agent-valley/commit/8b6b20a181b6e934c60d72d01414f848bc889091))

## [1.0.0](https://github.com/first-fluke/agent-valley/compare/v0.4.0...v1.0.0) (2026-10-04)

### Chores

- **release:** prepare version 1.0.0 ([e237251](https://github.com/first-fluke/agent-valley/commit/e237251c2fdbc4f920af9482728befce7c054496))

## [0.4.0](https://github.com/first-fluke/agent-valley/compare/v0.3.0...v0.4.0) (2026-10-04)

### ⚠ BREAKING CHANGES

- **chief:** Project configuration is read only from av.yaml. Rename existing valley.yaml files to av.yaml before running AV.

### Features

- address assessment findings across runtime and dashboard ([de66920](https://github.com/first-fluke/agent-valley/commit/de66920cc747694493f2eeab993b9966103e6fc3))
- **chief:** add durable goal coordination and verification ([1dfe7cc](https://github.com/first-fluke/agent-valley/commit/1dfe7ccf66d419985a1a32d1f17ad00fdc2a25c8))
- **chief:** automate verified missions with director teams ([7aa1ae7](https://github.com/first-fluke/agent-valley/commit/7aa1ae7fb0959270b35e7c33d101ae148210e816))
- **cli:** auto-register linear webhook and add av doctor ([958bfad](https://github.com/first-fluke/agent-valley/commit/958bfad29d055e9dc9c8120df79b3f90cdb8f7e9))
- **clients:** add durable MCP missions and native plugin exports ([d905d5b](https://github.com/first-fluke/agent-valley/commit/d905d5b32b3757ed1065daf94e9043b3a3267a26))
- **config:** auto-route issues to oma workflows and inject guidance ([2b57cd4](https://github.com/first-fluke/agent-valley/commit/2b57cd460c739d5d13182b4c17ee9f9061625764))
- **config:** wire max_parallel and add verify_command schema ([f33e331](https://github.com/first-fluke/agent-valley/commit/f33e331980940711c7cafea24b80f4154683d968))
- **dashboard:** bearer-token auth and mounted intervention ui ([2593d89](https://github.com/first-fluke/agent-valley/commit/2593d89a82d4c1366528c33efa7215035faec459))
- **observability:** budget persistence, otel genai, ledger relay ([77d8702](https://github.com/first-fluke/agent-valley/commit/77d87029b348d9f07e4f077e01da7826945679d6))
- **orchestrator:** thread agent pid for crash-recovery reattach ([414258d](https://github.com/first-fluke/agent-valley/commit/414258d5d2c455a68308695fc06983c01638acbb))
- **orchestrator:** verification gate, crash recovery, classified retry ([38af8ff](https://github.com/first-fluke/agent-valley/commit/38af8ffdd93e8beb62e150ed6abf0f4f34804b56))
- **qwen:** add native chief and actor support ([a607968](https://github.com/first-fluke/agent-valley/commit/a607968e4af7b0ab7b1827e1218ef800b67f060e))
- **security:** sandbox credential isolation and injection spotlighting ([8632373](https://github.com/first-fluke/agent-valley/commit/8632373c8d904ea58677d6532fec0398bdb1babc))
- **sessions:** add kimi (moonshot) as a supported vendor ([d0f8966](https://github.com/first-fluke/agent-valley/commit/d0f896620be0b97c13c3fbfcfe3f9b8cc1ab34fa))
- **sessions:** add opencode as a supported vendor ([c828d6b](https://github.com/first-fluke/agent-valley/commit/c828d6b83b9278fcacae9644ff6f199a0a26007b))
- **sessions:** os sandbox isolation with fail-closed default ([4bc17cc](https://github.com/first-fluke/agent-valley/commit/4bc17cca0446669e1b62ae9070a87c5cc6219b69))
- **sessions:** replace gemini with antigravity, cursor, grok adapters ([b11e8bc](https://github.com/first-fluke/agent-valley/commit/b11e8bcce03dc9a24d6088e7c8e703318069c35b))
- **setup:** preserve initiating agent in unattended installation ([1e95da0](https://github.com/first-fluke/agent-valley/commit/1e95da03fa6044d6793cd03cac2c3c8916cdec12))
- **tracker:** thread github delivery-id for precise webhook dedup ([1d60037](https://github.com/first-fluke/agent-valley/commit/1d60037b2cab05628ddcdd3d28225d761109f18b))
- **tracker:** timing-safe hmac and webhook replay dedup ([87a49b3](https://github.com/first-fluke/agent-valley/commit/87a49b3a5db848216d62785b0591db9c05da92fc))


### Bug Fixes

- await result handlers during shutdown ([e0849cf](https://github.com/first-fluke/agent-valley/commit/e0849cf0e463965556ab287fff766397cce1ac70))
- **cli:** report mission outcomes with accurate exit codes ([d5f58d2](https://github.com/first-fluke/agent-valley/commit/d5f58d28a262000ae5458cba07061ea9bf7aa5d1))
- **config:** reduce workflow-routing false positives ([55a9806](https://github.com/first-fluke/agent-valley/commit/55a9806599574fca864c4956d8ef40b856bf31a7))
- **install:** preserve OMA settings and pin source releases ([dd80c5a](https://github.com/first-fluke/agent-valley/commit/dd80c5ab5a118a42424ce09ffc9d8c948c6546a4))
- **oma:** verify strict receipt support for CLI 15.0.15 ([c5bc558](https://github.com/first-fluke/agent-valley/commit/c5bc5580f2ef2658e36a7bb431b250a9b3350b53))
- **plugins:** include licenses in distributed packages ([febb07a](https://github.com/first-fluke/agent-valley/commit/febb07a1a966df33d496ca51dcaac4bd15a11877))
- preserve linux workspace identity and isolate test fixtures ([acd7c2a](https://github.com/first-fluke/agent-valley/commit/acd7c2afbe79da2b4920c76ee0b39de676575647))
- **release:** publish standalone Node packages with aligned versions ([9b0c466](https://github.com/first-fluke/agent-valley/commit/9b0c466c05b69516d5b7a74b2070bc0e5d897d12))
- repair installation and agent farm lifecycle ([6ef27b1](https://github.com/first-fluke/agent-valley/commit/6ef27b1fe6bbecfc2d05615ab2e7801c34b81936))
- **workspace:** non-destructive merge-conflict resolution ([8d45efd](https://github.com/first-fluke/agent-valley/commit/8d45efdf769b198a206ac6f633ed8c2487b4ee41))


### Documentation

- document new config, env vars, and updated specs ([6812d61](https://github.com/first-fluke/agent-valley/commit/6812d61f001e0a80ee9a25cfb41ca8f10bf16979))


### Tests

- **chief:** allow parallel director completion order ([029199d](https://github.com/first-fluke/agent-valley/commit/029199dbce7e6c2ff93cbcbdd95d6a0e8b53c642))

## [0.3.0](https://github.com/first-fluke/agent-valley/compare/v0.2.0...v0.3.0) (2026-04-22)

### Features

- **cli:** add cloudflare tunnel support with provider abstraction ([ea23989](https://github.com/first-fluke/agent-valley/commit/ea23989397d43e3a0b2fe961d7aa05661115792e))

## [0.2.0](https://github.com/first-fluke/agent-valley/compare/v0.1.0...v0.2.0) (2026-04-22)

### Features

- add CLI login and team dashboard hooks (T6-T7) ([b1a2276](https://github.com/first-fluke/agent-valley/commit/b1a2276c7801f9865f904bb854da3942928ef082))
- add DELIVERY_MODE, non-blocking spawn, auto merge+push, SSE fix ([740509b](https://github.com/first-fluke/agent-valley/commit/740509b0f7309bd02b8c5d769f1d6e37bc14a66d))
- add issue CLI flags, fix orchestrator startup sync and workspace lookup ([4487a5d](https://github.com/first-fluke/agent-valley/commit/4487a5d5f557d319d729126ca3f269c00f696427))
- add replay, Supabase client, EventEmitter, LedgerBridge (T4-T5) ([5b7f069](https://github.com/first-fluke/agent-valley/commit/5b7f069789a268d3d4b68bb4d7425dd5cc293869))
- add team dashboard foundation (T1-T3) ([e444d1a](https://github.com/first-fluke/agent-valley/commit/e444d1a2465a408e9fe925a647bf9692f4932c9c))
- add Todo state config and Linear client mutations ([acad9c1](https://github.com/first-fluke/agent-valley/commit/acad9c11429df8dc9fe8a011a8dacd8923d91390))
- AgentSession abstraction layer ([e4a8e27](https://github.com/first-fluke/agent-valley/commit/e4a8e27589d10128953f74f6aba26a21ecb0bbe3))
- anti-premature-exit retry + safety-net draft PR creation ([cc8d327](https://github.com/first-fluke/agent-valley/commit/cc8d3278426e8ae203c39e6d468327752cb4d30f))
- **budget:** wire recordUsage from agent completion through to BudgetService ([3da1935](https://github.com/first-fluke/agent-valley/commit/3da1935e93b55acfa9176662189ef0ce0ec139f1))
- **cli:** add --scope option to issue command for routing label attachment ([ba9491e](https://github.com/first-fluke/agent-valley/commit/ba9491ea7c4bb23749c2f7f6606c2838af787251))
- **cli:** add av logs and av top commands ([08c3330](https://github.com/first-fluke/agent-valley/commit/08c3330cc92f8d5419d9b1fa981f19bd9ac187e5))
- **cli:** add av up/down daemon lifecycle commands ([a116991](https://github.com/first-fluke/agent-valley/commit/a11699121780cb3d2a8dd81174275df9915e696c))
- **cli:** add interactive setup wizard and CLI entry point ([e64faac](https://github.com/first-fluke/agent-valley/commit/e64faaca000f4e14b5b861dc73731581aec765f6))
- **cli:** add issue command with Claude CLI auto-expansion ([ca6b3d6](https://github.com/first-fluke/agent-valley/commit/ca6b3d67b621ae147be3af38f613d8686e0f339f))
- **cli:** improve setup TUI with step navigation, invite system, and edit mode ([f01e32d](https://github.com/first-fluke/agent-valley/commit/f01e32d38d18c5d3f4c6ac2715698a29a8b673e7))
- **cli:** prepare npm distribution with dual bin commands ([face26a](https://github.com/first-fluke/agent-valley/commit/face26a00de44b90ed7166df466fd409fa7b952a))
- **config:** add SCORING_MODEL and SCORE_ROUTING env vars with Zod validation ([0d2ef77](https://github.com/first-fluke/agent-valley/commit/0d2ef7753f6630e768455ca1c92129ba4c76ad9d))
- **config:** auto-detect MAX_PARALLEL from hardware specs ([c0d2ddd](https://github.com/first-fluke/agent-valley/commit/c0d2ddd8af867f5c06a5b0277d65e6ccdb5c3e15))
- **dashboard:** add AV favicon + web manifest ([2332ee4](https://github.com/first-fluke/agent-valley/commit/2332ee451b22e95bd41163b815faa5b40aa3c391))
- **dashboard:** add coffee cup for agents visiting coffee machine ([302b014](https://github.com/first-fluke/agent-valley/commit/302b01429ed11eff3d53066a796c8c985901798d))
- **dashboard:** add office pets, poop cleanup, L-shaped bathroom ([61db326](https://github.com/first-fluke/agent-valley/commit/61db3261d39e4fedb25bc3696b8dfecac02e54f8))
- **dashboard:** add office puppy + system metrics panel ([6008a32](https://github.com/first-fluke/agent-valley/commit/6008a32c13ce24fb884c1d46d4e9dfdb037a3c11))
- **dashboard:** add pixel art office dashboard with Next.js 16 ([ba4913f](https://github.com/first-fluke/agent-valley/commit/ba4913fe68259c2d42610cc783cf03fd3e231f0e))
- **dashboard:** add team mode UI components (T8) ([6886c9d](https://github.com/first-fluke/agent-valley/commit/6886c9d009ae8208f2c25ff8b4c8b1f0d83ee33a))
- **dashboard:** add waypoint system for bathroom wall-clip prevention ([35654b0](https://github.com/first-fluke/agent-valley/commit/35654b01ac00c54d4176257dbb9ca9748c8d5eac))
- **dashboard:** dynamic office with parallel agents, skins, and wandering ([d765dc0](https://github.com/first-fluke/agent-valley/commit/d765dc006f87d6421d59cf1bd355d091e48b8d2c))
- **dashboard:** integrate real orchestrator with @t3-oss/env-nextjs ([d4010b0](https://github.com/first-fluke/agent-valley/commit/d4010b088c22289f8b5075f241cf8e9a2b1f1133))
- **domain:** add Issue.score field, ScoreAnalysis type, and parseScoreFromLabels ([b53ec80](https://github.com/first-fluke/agent-valley/commit/b53ec8044ccd616d6cbe2b0879c19c28bb9ce01f))
- full issue lifecycle — Todo pickup, Done/Cancelled transitions, comments ([a547d8d](https://github.com/first-fluke/agent-valley/commit/a547d8d7e96dbc8a64d93eee524d8b225f413760))
- harness scripts (dev, gc, validate) ([d792bd6](https://github.com/first-fluke/agent-valley/commit/d792bd60f4f5810e647d1d7102f0e359d29cb034))
- install.sh for new and existing projects ([e6a3828](https://github.com/first-fluke/agent-valley/commit/e6a38284bc012bceee28cfd9daad70b1c03f7f62))
- integrate score routing into orchestrator and CLI ([feb09ad](https://github.com/first-fluke/agent-valley/commit/feb09adf768af6e38f08c4414cdabd689734d434))
- **observability:** add OTel tracing + Prometheus metrics (disabled by default) ([0782d93](https://github.com/first-fluke/agent-valley/commit/0782d93a36d46014f5e937c5285b814c6003b70b))
- oh-my-agent skills and Claude Code sub-agents ([1110e5b](https://github.com/first-fluke/agent-valley/commit/1110e5bb845d96dc759a6fbc2dbb1593c98c0148))
- **orchestrator:** add Budget service with per-issue / per-day caps ([c0d709c](https://github.com/first-fluke/agent-valley/commit/c0d709cbe4c80c268c8eca0faa1f5b9135284a47))
- **orchestrator:** add DAG-based issue dependency scheduling ([867d537](https://github.com/first-fluke/agent-valley/commit/867d53785ea5a469ea40532b5fac8d887674bdf9))
- **orchestrator:** add Live Intervention (pause/resume/abort/append_prompt) ([1811342](https://github.com/first-fluke/agent-valley/commit/1811342f490f67a4ea731499a064c7dcf8b62cb2))
- **orchestrator:** add safety-net auto-commit, instant ack, anti-premature-exit ([2f40118](https://github.com/first-fluke/agent-valley/commit/2f40118a4ec1338c3091f568c75cef4b82d10db0))
- **orchestrator:** add ScoringService, helpers, and resolveRouteWithScore ([e3176c4](https://github.com/first-fluke/agent-valley/commit/e3176c4eda6097cfd467831aa350a346cdb7a3ad))
- Symphony Orchestrator implementation (TypeScript + Bun) ([54c2bc4](https://github.com/first-fluke/agent-valley/commit/54c2bc4ac7781494a8941b8d9fa9dbecefe4d6af))
- **tracker,workspace:** add labels to issue type, support per-route workspace root ([cf6664d](https://github.com/first-fluke/agent-valley/commit/cf6664dcd426dcba29cc187085eb3e52f96a45c3))
- **tracker:** add addIssueLabel with on-demand creation and score label parsing ([939614a](https://github.com/first-fluke/agent-valley/commit/939614aa81b06bcd8813666ca47ac1efdbe00f04))
- **tracker:** add GitHub Issues adapter (IssueTracker + WebhookReceiver) ([04b21cf](https://github.com/first-fluke/agent-valley/commit/04b21cf7bba1cb1409540eacbf780e97b3180df5))
- webhook-driven architecture (replace polling) ([a5ae54a](https://github.com/first-fluke/agent-valley/commit/a5ae54af61da8990c219459f5b6a2e6962d84c6f))
- workflow routing in WORKFLOW.md prompt ([399c2cf](https://github.com/first-fluke/agent-valley/commit/399c2cf0775a7aa603a7e7b193dd2a89d9b8d738))
- **workflow:** enforce related-tests-only + untrusted content defense ([5a6d3cd](https://github.com/first-fluke/agent-valley/commit/5a6d3cd3d0634956e2e29168359fc827387ffb8b))
- **workspace:** auto-resolve merge conflicts with theirs strategy ([86440af](https://github.com/first-fluke/agent-valley/commit/86440af647193e18f45cb30ff7fcc621ae7c7888))


### Bug Fixes

- address /review findings — auth, RLS, pagination, cancelled event ([943a5f7](https://github.com/first-fluke/agent-valley/commit/943a5f71244599abaf9e78f14aea7fdada62af29))
- address REFINE review — dedupe types, fix user_id, add displayName ([3b48ed6](https://github.com/first-fluke/agent-valley/commit/3b48ed6a777393f40ed089eacf274807533fd878))
- cap ClaudeSession output buffer to prevent OOM crash ([816ecd2](https://github.com/first-fluke/agent-valley/commit/816ecd2f584d1f91a5a81d3157186beee9ccd944))
- **ci:** activate Bun + TypeScript CI pipeline ([00be14b](https://github.com/first-fluke/agent-valley/commit/00be14bbcee506147f7e1af8afc1f71e4f1143ac))
- **ci:** move runner.temp to job-level env, add lint-staged + pre-push hook ([2968a42](https://github.com/first-fluke/agent-valley/commit/2968a4257399c099d40f31719c20399be03c3b42))
- **ci:** move runner.temp to step-level env (unavailable at job-level) ([68f1372](https://github.com/first-fluke/agent-valley/commit/68f1372bae47edaf54bdd27cc26b17e519eab4ca))
- **ci:** resolve all typecheck errors, split tsc per workspace ([f342907](https://github.com/first-fluke/agent-valley/commit/f342907dd3f4514593c438b5de8dd20f5799e368))
- **ci:** use marketplace action for oma-update ([e21b0b8](https://github.com/first-fluke/agent-valley/commit/e21b0b869bbaa4489e36861f45118111062f6974))
- **core:** fix av up supervisor restart loop and standalone path resolution ([b1154b2](https://github.com/first-fluke/agent-valley/commit/b1154b26be4aae19dabcb53bd13f1f56f87dc60b))
- **core:** pass env to spawned git processes and add oma update workflow ([f6db6e3](https://github.com/first-fluke/agent-valley/commit/f6db6e39c148fa3d67afc85921cb059241fa32dc))
- **core:** preserve linear mocks under vitest ([429a536](https://github.com/first-fluke/agent-valley/commit/429a536c6796caa8411a55b98b305d98bf79c8b6))
- **core:** prevent .agent-valley metadata from causing merge conflicts ([27a911d](https://github.com/first-fluke/agent-valley/commit/27a911d209a96baa50b473870f0f1f545ff75f3d))
- **core:** resolve 10 production gaps in orchestrator pipeline ([232e715](https://github.com/first-fluke/agent-valley/commit/232e71515d1802f470ff7a41ad743c593d3521de))
- **dashboard:** eliminate SSE connection leak and reduce memory pressure ([990274d](https://github.com/first-fluke/agent-valley/commit/990274d1db5dd449894ee83bd1e022d327ebdb86))
- **dashboard:** harden /api/status and /api/events ([9ce4c92](https://github.com/first-fluke/agent-valley/commit/9ce4c92e40c3a385ef450809024a2779b2c00d0b))
- **dashboard:** remove env-dependent test, tests should be self-contained ([d82e97c](https://github.com/first-fluke/agent-valley/commit/d82e97c71d9976e05c17c7496d1a618e4541e201))
- **dashboard:** remove imageRendering pixelated to fix broken text ([2cfe7dd](https://github.com/first-fluke/agent-valley/commit/2cfe7ddc49a666980dcb39c8d4b204b635896374))
- **dashboard:** replace removed env import with toOrchestratorConfig ([7612638](https://github.com/first-fluke/agent-valley/commit/7612638adbc001211f00383c44aa4264557520ad))
- eliminate session output accumulation + add supervisor self-healing ([452b77f](https://github.com/first-fluke/agent-valley/commit/452b77f24065c4524e0154773bf94ba593b945fc))
- monorepo path resolution — cwd-based ROOT, remove @/ alias from core ([8253e30](https://github.com/first-fluke/agent-valley/commit/8253e302a8f35809450bf82f896bcd18b3383602))
- **orchestrator:** clamp retry backoff exponent for attemptCount=0 ([fb36d1d](https://github.com/first-fluke/agent-valley/commit/fb36d1d3063c5231c6cb044b8700c983116a0fc2))
- **orchestrator:** recover startup sync and routed worktrees ([3052f80](https://github.com/first-fluke/agent-valley/commit/3052f8039d8c50205a9fc0e9cb7eca4a481d43a7))
- **orchestrator:** resolve race conditions, orphan processes, and N+1 queries ([c76436f](https://github.com/first-fluke/agent-valley/commit/c76436f61513e47a72a463779c7f91c6e6d2afae))
- prevent orchestrator errors from crashing dashboard + auto-restart ([e72b4f9](https://github.com/first-fluke/agent-valley/commit/e72b4f9c69abc0ea8b3a5517389f1f747cf15033))
- pull --rebase before merge, retry on push rejection ([695c69e](https://github.com/first-fluke/agent-valley/commit/695c69ee63362d60fff19d8f3cad777fb03b2c63))
- resolve pre-existing lint and validation violations ([65b5c10](https://github.com/first-fluke/agent-valley/commit/65b5c1040c76c05406e7d368782c818462ac2886))
- **security:** sanitize untrusted input in prompts and harden HTTP server ([aa73d4d](https://github.com/first-fluke/agent-valley/commit/aa73d4d5323fbb8ec5f9b143e3abf776e7be36ba))
- **sessions:** add --verbose flag and USER env var for Claude CLI auth ([bdf386d](https://github.com/first-fluke/agent-valley/commit/bdf386dc62084590a5c820af11905be8ecc30059))
- **sessions:** resolve memory leaks, listener cleanup, and module-level state ([dafc77c](https://github.com/first-fluke/agent-valley/commit/dafc77c78d32ca2e2b3bcf50c0748d3033591f6c))
- **skills:** quote backend-agent description ([b27cd2a](https://github.com/first-fluke/agent-valley/commit/b27cd2a11b4e0c16f602f52868b4ecc9639f0ca2))
- standalone static files — symlink .next/static + public into standalone dir ([1c32dae](https://github.com/first-fluke/agent-valley/commit/1c32dae64ce7eec1a76653e29b7eb04bd46601d0))
- **test:** resolve typecheck errors in new test files ([92baa6a](https://github.com/first-fluke/agent-valley/commit/92baa6a42b8024c0832e7fc7589f4d06a9e377aa))
- **test:** update config import path and animation loop assertion ([c0d2ddd](https://github.com/first-fluke/agent-valley/commit/c0d2ddd8af867f5c06a5b0277d65e6ccdb5c3e15))
- **tracker:** add Zod runtime validation, cursor pagination, and config improvements ([deabeed](https://github.com/first-fluke/agent-valley/commit/deabeed3d1e3c87644265dc30de833aa7b28c199))
- **tracker:** fetchIssueByIdentifier and createIssueRelation Linear API bugs ([9d923ed](https://github.com/first-fluke/agent-valley/commit/9d923ed3bd378ab049b753fc30aa7d145c4b9931))
- **tracker:** make Linear mutation errors self-correcting ([c85215b](https://github.com/first-fluke/agent-valley/commit/c85215bf555b463acd2f8de1e80692d4171c820c))
- **workspace:** retry regeneratable lockfile conflicts ([60861a6](https://github.com/first-fluke/agent-valley/commit/60861a61986819939667998dd9bc9c4b1b834626))
- zod/v4 → zod import (v4 is already installed as zod@4.x) ([abca7b3](https://github.com/first-fluke/agent-valley/commit/abca7b312a9aac8438dd580b2eb97b4b5c043060))


### Refactors

- **arch:** move HTTP server startup from Orchestrator to main.ts ([5314942](https://github.com/first-fluke/agent-valley/commit/5314942a711007826c735ef1bae7ca79256876a2))
- **cli:** av dev runs Next.js dashboard + ngrok, remove dead http-server ([f5ec3c8](https://github.com/first-fluke/agent-valley/commit/f5ec3c8e8c5a9565c5c25184423c27b9e1c497ba))
- **cli:** replace all Bun APIs with Node equivalents + clean stale files ([93bddda](https://github.com/first-fluke/agent-valley/commit/93bddda031a4f27fc2eabf2fc8347ace1ebb3456))
- **config:** rename config.ts to env.ts ([b404faf](https://github.com/first-fluke/agent-valley/commit/b404faf5ee535daa14c3cf75bf3fe7e295cadf28))
- **config:** split .env into global settings.yaml + project valley.yaml ([444a01b](https://github.com/first-fluke/agent-valley/commit/444a01baadbe9d6cb0dbaf74a8a7bd195d05cd6c))
- conventional branch naming + .agent-valley metadata dir ([0c7e3ac](https://github.com/first-fluke/agent-valley/commit/0c7e3ace3cab02f835d5f33506e67b390551c703))
- **core:** introduce domain ports and DI seam for tracker/webhook/workspace ([de4d395](https://github.com/first-fluke/agent-valley/commit/de4d395c601b28cad2be4c0d8072e719ffc9d8e3))
- **core:** replace Bun.spawn with node:child_process in scoring-service ([aa3b08c](https://github.com/first-fluke/agent-valley/commit/aa3b08c734ed88a06bdd11ca8bb9f24aee44420c))
- **domain:** promote ParsedWebhookEvent to domain + introduce AgentRunnerPort ([760e6c0](https://github.com/first-fluke/agent-valley/commit/760e6c093ed808c3dd15d08a7f167264515bf029))
- eliminate all lint warnings with type-safe guards ([71cf925](https://github.com/first-fluke/agent-valley/commit/71cf925e535f470bc0859cbeb612d520f2d64a98))
- **orchestrator:** split Orchestrator into core/lifecycle/router modules ([a773d17](https://github.com/first-fluke/agent-valley/commit/a773d1731a0a99445d3262786a4180f598901ab7))
- replace Bun-specific APIs with Node.js standard equivalents ([de7546c](https://github.com/first-fluke/agent-valley/commit/de7546cef7acaf709984fa2901dd5f5a2ac6a5a2))
- restructure into Bun workspace monorepo (apps/ + packages/) ([1cc0e34](https://github.com/first-fluke/agent-valley/commit/1cc0e34a08846959f3586664bf917489123f5df2))
- **workspace:** rebase-based merge delivery instead of --theirs ([3ccb992](https://github.com/first-fluke/agent-valley/commit/3ccb9928e1715057f0025e0ea11aa676455b36d9))
- **workspace:** split WorkspaceManager into worktree/delivery/safety-net modules ([91d2c73](https://github.com/first-fluke/agent-valley/commit/91d2c73dec15a02fb313773d131ca5d9ba3628b3))


### Performance

- av up builds standalone + runs production server ([78220dc](https://github.com/first-fluke/agent-valley/commit/78220dc2205ad952c392bae9991f033154f5d645))


### Documentation

- add integration tests, CHANGELOG, and v0.2 documentation ([a82a209](https://github.com/first-fluke/agent-valley/commit/a82a209734208c4f70f85f3089019c54650e5b84))
- add issue creation rules and version-check step to WORKFLOW.md ([0830985](https://github.com/first-fluke/agent-valley/commit/0830985db5305add247b4d03d9db6ee8470a7ade))
- add product requirements document v0.1 ([b5143fd](https://github.com/first-fluke/agent-valley/commit/b5143fd081b87400271be5ccd8d2b48f704861a1))
- **architecture:** add review artifact with prioritized findings ([5b9a01c](https://github.com/first-fluke/agent-valley/commit/5b9a01c022a17a2d7fb2e3a725005319d8419d1f))
- clarify new project setup flow ([2a051cd](https://github.com/first-fluke/agent-valley/commit/2a051cd1f0ddf6c2e158f37661c0edc9200ee2aa))
- **claude:** correct paths to monorepo layout ([9242c58](https://github.com/first-fluke/agent-valley/commit/9242c58b502eebdc5f229c660e93ba3620d65ca6))
- **guides:** document SYMPHONY_DASHBOARD_TOKEN and SYMPHONY_ALLOW_REMOTE_STATUS ([f77a395](https://github.com/first-fluke/agent-valley/commit/f77a3958b5176a5a1515d145331778587b3fd51b))
- project documentation (AGENTS, README, AGENT_SETUP) ([4b4e49d](https://github.com/first-fluke/agent-valley/commit/4b4e49db950d752b8c9128e9743b3cf053316fb1))
- Symphony SPEC and architecture documentation ([0096044](https://github.com/first-fluke/agent-valley/commit/0096044fba58d702f8cfc9d42d1394df6df044a6))
- translate all documentation to English ([9b09fec](https://github.com/first-fluke/agent-valley/commit/9b09fec561e3508ca1f0471576c98c60487d405e))
- update all docs for issue lifecycle flow ([2f74b1f](https://github.com/first-fluke/agent-valley/commit/2f74b1fcc8b19fafdeb7530b3ad1fb4f0d8f7138))
- update README product name to agent-valley, license to AGPL-3.0 ([2332a2c](https://github.com/first-fluke/agent-valley/commit/2332a2c956decc39b02d7cd3b2960600c8cdae46))
- update README to reflect current monorepo implementation ([51f3e34](https://github.com/first-fluke/agent-valley/commit/51f3e3465d2f30c454d0e99bebbeac4941dbacd8))


### Tests

- add ClaudeSession streaming tests (output, OOM, events, cap) ([76a75e4](https://github.com/first-fluke/agent-valley/commit/76a75e46ebddbccff00d0d4d7edffcbefce8594a))
- add coverage gate (lines 80% / branches 70%) to validate.sh ([3edb151](https://github.com/first-fluke/agent-valley/commit/3edb151e50a46402e14d1a37dd8dd1e994f8f791))
- add regression tests for SSE connection leak and metrics caching ([106a4a0](https://github.com/first-fluke/agent-valley/commit/106a4a0c37de49be948def31cf799a057a27a08a))
- add score routing tests and design document ([db30291](https://github.com/first-fluke/agent-valley/commit/db3029136b55bee5d64274e9d1985972196a0ee8))
- add unit and integration tests (99 tests, 0→100% core coverage) ([7df235c](https://github.com/first-fluke/agent-valley/commit/7df235cebcf290aa21167ff58c61c3a4b9965630))
- **core:** add characterization suites for orchestrator and workspace-manager ([2e8664c](https://github.com/first-fluke/agent-valley/commit/2e8664c74877250865658185c1df57f24dcfe07c))
- **core:** increase unit test coverage to 86% (from 77%) ([202fffb](https://github.com/first-fluke/agent-valley/commit/202fffb81a3593f585399a06c4a2572ccfff7cab))
- **core:** relax flaky completion retry timeout ([0190fb3](https://github.com/first-fluke/agent-valley/commit/0190fb3fb0d339e033e4be483ca58cbcceb04bf5))
- update CLI and dashboard tests for YAML config ([fdfdd38](https://github.com/first-fluke/agent-valley/commit/fdfdd383c64f8b9da9c21fb331e93f395e19a894))
- update office-layout tests for bathroom bump dimensions ([ba7e48c](https://github.com/first-fluke/agent-valley/commit/ba7e48cd2b2497946a0a5aeb4b8db3321221e325))


### Chores

- **release:** drop bump-patch-for-minor-pre-major so feat bumps minor ([bbc7467](https://github.com/first-fluke/agent-valley/commit/bbc74670459ecdb441e6129336fc9f3313af9dfe))

## [0.1.0] - 2026-04

Initial release. Linear tracker + Claude / Codex / Gemini agents + retry
queue + DAG scheduler + multi-repo routing + score-based routing + team
dashboard beta.
