# Actor sessions

Agent Valley includes ten Actor types: `claude`, `codex`, `qwen`, `dsh`, `zcode`,
`antigravity`, `cursor`, `grok`, `kimi`, and `opencode`. Set `actor.type` in
`av.yaml` or `~/.config/agent-valley/settings.yaml`; project settings win.
For local orders, `av order --actor <type>` overrides that order's selection.
Use `av setup` to save a selection and `av doctor` to inspect local readiness.

These are AV execution adapters. Installing a vendor's AV skill or MCP entry is
a separate client integration described in [agent clients](./agent-clients.md).

## Qwen Code

Install the official CLI with `npm install -g @qwen-code/qwen-code` and complete
its native authentication setup. Qwen supports OAuth and configured API-key
providers. Use `qwen` and `/auth` to select authentication; see the official
[authentication guide](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth/).

AV invokes `qwen --output-format stream-json --yolo` and sends the prompt as
plain stdin. An explicit session model adds `--model <model>`. Native Computer
Use exclusions follow the existing trusted session configuration; this adapter
does not replace native OS consent. The
[headless guide](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless/)
documents the output mode.

`QWEN_HOME` selects the user profile; otherwise Qwen uses `~/.qwen`. AV forwards
the configured provider's allowlisted keys, endpoint and model variables,
including `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `QWEN_MODEL`, and
the supported Anthropic, Gemini, Google and DashScope/Bailian equivalents,
plus `QWENCLOUD_API_KEY` and `QWENCLOUD_TOKEN_PLAN_API_KEY`.
Profile configuration and selected provider must agree. Credential detection
reports local evidence and does not make a model request.

A successful top-level `result` envelope and exit zero are required. Child
results cannot finish the enclosing Actor. Usage comes from native totals;
cached input is not added a second time. Missing or malformed usage remains
unknown. Multiple observed models are reported as mixed usage.

## DeepSeek Harness (DSH)

Install the official package with `npm install -g @deepseek-ai/dsh` so `dsh` is
on PATH. Use a release whose headless profile supports `--json` and stdin.
AV runs:

```sh
dsh --profile headless --json --permission-mode danger-full-access --approval-policy never -
```

The prompt is sent through stdin. AV's outer OS sandbox governs filesystem and
process containment; native approval requests cannot leave an unattended run
waiting for input. Each execution starts a fresh native Session.

The shipped headless profile uses API-key credentials, including
`DEEPSEEK_API_KEY`; its native `.env` fallback checks the invocation directory,
then `$DSH_HOME/.env`. It disables the managed GUI credential store by default.
A saved Web/GUI sign-in therefore does not establish headless readiness.
`DSH_HOME` defaults to `~/.dsh`. Inside its `profiles` directory, the `headless`
profile's `cordis.patch.yml` supplies overlays. Configure model/provider selection through
that native profile: the mounted `@deepseek-ai/dsh-agent-default-model` entry
uses `config.provider`, `config.model`, and optional `config.reasoningEffort`
([native model reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-default-model/README.md)).
DSH has no headless `--model` flag: omit `actor.model` and
`--model` when selecting `dsh`; AV rejects a pin it cannot apply.

AV requires an opening native Session identity, a matching unique `final` event
whose `reason.kind` is `completed`, and exit zero. Cancellation cannot succeed
merely because DSH handles SIGTERM with exit zero. Step usage is summed only
when every reported step has valid totals. Model identity is not carried by
this projection, so usage is labeled `dsh-native-route` and its model price
remains unknown. Native tool events are exposed; AV does not infer successful
file modifications from a requested tool call.

The official [headless reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md),
[argument parser](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/startup.ts),
and [JSON projection](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/src/json-stream.ts)
define this contract. The general CLI overview can lag these package-specific
options; use the installed headless help when checking version compatibility.

## ZCode

Install the official Z.ai Agent CLI as `zcode` on PATH, using the
[CLI quickstart](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/01-quickstart.md).
The Agent CLI can run from its native `dist/zcode.cjs` entrypoint or a packaged
executable. Use the Agent CLI entrypoint for AV. Authenticate with `zcode login` (or `zcode login --no-browser`).

AV invokes:

```sh
zcode --prompt '<task>' --mode yolo --output-format stream-json --no-color
```

The prompt is one argv value without shell interpolation; stdin is closed.
ZCode has no per-invocation `--model` option. Configure native
`defaultModelSelection`, and omit `actor.model` and `--model` for `zcode`.
AV rejects a model pin it cannot apply. The official
[CLI reference](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/02-cli-reference.md)
and [configuration guide](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/docs/usage/03-config.md)
describe those native settings.

The native profile root defaults to `~/.zcode`. `ZCODE_DATA_BASE_DIR` names its
parent directory: ZCode appends `.zcode`. Provider configuration is at
`<parent>/.zcode/v2/provider_config.json`. CLI resources/configuration stay under
`$HOME/.zcode/cli`, including `config.json`, independently of that override; see
[configurable data directory](https://github.com/zai-org/ZCode/blob/main/docs/desktop/configurable-data-directory.md).
Keep both locations available to the AV process.

`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` selects a separate provider configuration
file. Use an absolute path in a dedicated configuration directory so native
locking and atomic updates fit the sandbox. AV also forwards
`ZCODE_CREDENTIAL_SECRET` when set, preserving the native credential encryption
key without storing it in mission state.

Automatic discovery recognizes configured API providers. A native account
login alone remains `unknown` because the CLI has no verified read-only account
status probe. An explicitly selected Chief Director remains selectable; its
native run establishes whether the login works.

A native `result` with a string `response`, an idle projection, no failed or
cancelled turn, and exit zero is required for success. Provider-reported usage
uses `inputTokens` and `outputTokens`; cached input is a subset. Native model
identity comes from session updates; nested model usage keeps aggregate model
attribution unknown. These are the native result's observed turn totals, not a
verified bill for every workflow follow-up or subagent. Missing or malformed accounting stays
unknown rather than being reported as zero usage or a verified price.

## Interventions and verification

Qwen, DSH, and ZCode expose `abort` through the local runner. They do not
advertise pause/resume or live prompt appends. Cancellation and disposal join
the owned local process; native protocol output is assessed separately from
task correctness and repository verification.

Deterministic fixtures verify argument construction, protocol parsing, terminal
success/failure, token accounting and process cleanup. An installed executable,
saved credentials, and passing fixture tests do not establish a successful live
provider call. Provider acceptance requires a separately observed native run;
repository task completion still requires its configured checks and review.
