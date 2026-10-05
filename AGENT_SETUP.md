# Install and configure AV with an agent

Give this document and a target repository to an agent that can run commands on the target machine. The user-facing agent that receives the installation request becomes AV's Chief Director. It installs AV, prepares OMA and project MCP settings, checks readiness, and reports what is complete or still needs action.

Capture that initiating session's vendor and model choice before delegating installation. A worker must pass them unchanged to `--actor` and `--model`; its own vendor/model never replaces the initiating agent. An explicit user override takes precedence.

This procedure requires the user's installation request. Reading or downloading this document alone does not authorize changes. Follow the user's constraints and the target repository's execution policy. Installation does not authorize a mission, a build, a purchase, account changes, publishing, or changes to client trust settings.

## Copy-paste request

Replace the repository path and give this request to your local agent:

```text
/absolute/path/to/repo에 AV를 설치하고 설정해줘.
https://raw.githubusercontent.com/first-fluke/agent-valley/main/AGENT_SETUP.md 를 따라
너 자신을 Chief Director로 지정해줘. 현재 세션의 정확한 모델을 확인할 수 있으면
그 모델을 유지하고, 확인할 수 없으면 native default를 저장하고 그렇게 보고해줘.
AV 설치, OMA 준비, 프로젝트 MCP 설정을 승인한다.
설정 확인용 미션은 실행하지 말고, 실제 완료 항목과 남은 조치를 보고해줘.
```

ChatGPT or Claude in a browser without local shell access cannot perform this installation. Report that limit and have a local shell-capable agent carry out this same request. A web account connection requires a separately configured public MCP server; local setup does not create one.

## Resolve the initiating agent's identity

Use the initiating agent runtime's trusted identity to choose the Chief Director. A delegated worker uses the identity passed by that initiating session. Do not choose from installed executables, authentication state, repository OMA settings, price, or a model's provider name. For example, an OpenCode session using an OpenAI model remains an `opencode` Chief Director.

| Initiating agent runtime | `--actor` |
|---|---|
| Codex | `codex` |
| Claude Code | `claude` |
| Cursor | `cursor` |
| Qwen Code | `qwen` |
| Antigravity | `antigravity` |
| Grok CLI | `grok` |
| Kimi CLI | `kimi` |
| OpenCode | `opencode` |

Pass the exact active model only when trusted session metadata or the effective runtime configuration confirms it. Static configuration or a variable such as `ANTHROPIC_MODEL` alone may have been overridden in the session. Do not invent or translate model aliases. If the exact model is unavailable, pass `--model ''`: this clears a saved model pin and uses that CLI's native default. Report that the exact session model was not pinned. Never change the Chief Director to another vendor because it is cheaper or already authenticated. AV can route Actors independently.

If the runtime identity cannot be established or has no supported adapter, report `action_required` with that specific limit. Do not guess a vendor or ask the user to choose one merely because the exact model is unknown.

## Install on the target machine

Resolve the user-selected repository to an absolute path. It must be a Git repository with at least one commit. Check this prerequisite without changing Git history. Preserve existing repository files and user configuration. Check only the needed paths and readiness results; do not print credentials or dump the environment.

If `AGENT_VALLEY_MANAGED_RUN=1` or you are executing an existing AV Chief Director/Actor assignment, perform that assignment directly. Do not start a nested setup or AV mission.

Run the official installer from the selected repository:

```bash
set -o pipefail
cd /absolute/path/to/repo
curl -fsSL https://raw.githubusercontent.com/first-fluke/agent-valley/main/scripts/install.sh \
  | bash -s -- --yes --no-workflows --no-setup
```

The installer prepares the required Node.js/Bun runtime and AV launcher without a software build. These flags defer interactive setup and optional repository CI workflows. The installer can also prepare project integrations; the following setup step checks them again with the saved project binding. Check its exit status and actual output before continuing.

Existing OMA and vendor instruction trees are retained. OMA preparation in the next step owns their updates. Other harness files are checked for content, type, and symlink conflicts before copying; a conflict stops installation with the affected path. Preserve that file and report the required reconciliation.

The default source ref is `main`. For a release that includes ref selection, fetch the installer from the chosen published `vX.Y.Z` tag and pass that same tag as `--ref vX.Y.Z` (or `AGENT_VALLEY_INSTALL_REF`). The flag takes precedence over the environment variable. A tag URL alone does not select the installed checkout. Keep this ref on retries; tagged checkouts stay at that tag, and updates refuse dirty or diverged source checkouts.

Use the launcher's installed path rather than relying on the current shell's PATH. Respect an existing `AGENT_VALLEY_BIN_DIR` or an explicitly selected installed launcher:

```bash
AV_SETUP_BIN_DIR="${AGENT_VALLEY_BIN_DIR:-$HOME/.local/bin}"
AV_SETUP_BIN="$AV_SETUP_BIN_DIR/av"
export PATH="$AV_SETUP_BIN_DIR:$PATH"
"$AV_SETUP_BIN" setup --help
```

If an existing launcher is from an older release and lacks the flags below, update it through the installer before proceeding. Do not run a mission to check the launcher.

The installer also supports `--headless --actor <initiator-vendor> --model <confirmed-model-or-empty> --oma prepare`. That path uses the current invocation project as the target and propagates setup's exit status, but prints progress text and has no separate target flag. Do not combine `--headless` with `--no-setup`. Use the canonical two-step procedure when the user selected a specific target repository, or when you need setup JSON or a saved `--verify` command.

## Save configuration and prepare dependencies

Set `AV_SETUP_WORKSPACE` to the user-selected absolute repository path and `AV_SETUP_ACTOR` from the verified initiating runtime identity. This example is for a Codex initiating session whose exact active model is unavailable; another initiating runtime must use its own table entry. If its exact active model is confirmed, assign that exact ID to `AV_SETUP_MODEL`. A delegated worker preserves these values, including the empty native-default value. Carry the resolved invocation directory and variables into each tool call; do not assume a fresh shell retains earlier assignments.

```bash
AV_SETUP_WORKSPACE='/absolute/path/to/repo'
AV_SETUP_BIN_DIR="${AGENT_VALLEY_BIN_DIR:-$HOME/.local/bin}"
AV_SETUP_BIN="$AV_SETUP_BIN_DIR/av"
AV_SETUP_ACTOR='codex'
AV_SETUP_MODEL=''
export PATH="$AV_SETUP_BIN_DIR:$PATH"
cd "$AV_SETUP_WORKSPACE"
"$AV_SETUP_BIN" setup --yes \
  --actor "$AV_SETUP_ACTOR" --model "$AV_SETUP_MODEL" \
  --workspace "$AV_SETUP_WORKSPACE" --oma prepare --json
```

Always pass this explicit workspace for the user-selected target. Otherwise setup may retain an existing `workspace.root` that points to a different repository.

`--yes` performs local order setup without prompts. It saves `av.yaml` in the invocation directory and Chief Director defaults in `~/.config/agent-valley/settings.yaml`, prepares OMA in the working repository, and installs the project AV skill and MCP entries for Codex, Claude Code, Cursor, Qwen Code, and Antigravity. It uses the existing provider acquisition and readiness adapters. It does not run a paid model probe, start a mission, or complete browser/device login unattended.

OMA preparation is the default. Use `--oma skip` only if the user asks to defer OMA, and report the deferral. An OMA failure must be reported; do not silently turn it into a skip. Preserve existing OMA configuration and use the supported installer/update path instead of editing managed definitions directly.

Leave `--verify` unset unless the user supplied a trusted check or the selected repository already defines one that you can confirm. To save such a check, append `--verify 'the existing trusted check'`. Setup saves this acceptance command; readiness verification does not require executing a mission or building software.

Usually the configuration directory and working repository are the same. If the user identifies configuration directory A and working repository B, run setup from A and pass `--workspace B`:

```bash
cd /absolute/configuration-A
"$AV_SETUP_BIN" setup --yes \
  --actor "$AV_SETUP_ACTOR" --model "$AV_SETUP_MODEL" \
  --workspace /absolute/repository-B --oma prepare --json
```

Configuration and mission history stay in A, `workspace.root` selects B, and the client integration in B launches `av mcp --workspace A`. Preserve that binding when retrying or repairing an integration.

## Check the result without starting work

Read setup's JSON and exit status. Its report includes project/config paths, Chief Director selection and readiness, OMA and integration results, and `nextActions`.

| Setup status | Exit | Agent action |
|---|---|---|
| `ready` | `0` | Report the verified local setup and any remaining client reload/trust step. |
| `action_required` | `2` | Preserve saved configuration, report the exact next action, and stop unattended retries. Rerun the same setup command after the action is complete. |
| `failed` | `1` | Report the actual error and affected path. Fix an authorized, understood cause or report the remaining blocker. |

An installed executable does not prove authentication. Unknown authentication or model readiness must remain visible in the report. Browser/device sign-in is a concrete user action; do not bypass it or choose another vendor to avoid it.

Inspect the integration result's client files and confirm the MCP server points to the configuration directory above. Restart or reload the selected agent client and let the user complete its normal workspace/MCP trust step when required. Desktop clients may need the AV launcher directory on their PATH.

If the current client already exposes the AV tools, use the read-only `av_missions` call to confirm `project` equals the configuration directory, `workspace` equals the selected working repository, and the execution context matches the current session. For the A/B case, check both `project=A` and `workspace=B`. Report this check as pending if the client needs a reload or cannot expose newly installed tools in the current session. Do not call `av_order`, `av_resume`, or any sample goal merely to verify setup.

## Recover while preserving files

- For login or unknown readiness, follow the reported vendor action and rerun the same setup command after login. Do not loop unattended.
- For an OMA preparation error, retain its diagnostic and fix the stated dependency, permission, or installer failure before retrying. Defer only at the user's request.
- For an AV skill/MCP name collision or locally edited owned file, preserve the original. Reconcile the reported file only when its ownership and intended binding are established. Keep unrelated entries and user changes; report `action_required` if resolving the collision needs a user decision. Do not delete files or force a managed update.
- For a missing or malformed configuration key, use the error's key path and named file. Repair only the requested setting and keep unrelated configuration.
- After an interrupted installation, inspect the installed launcher and existing configuration before retrying. Reuse saved paths and bindings instead of creating a second project.

## Report to the user

Report the target repository and configuration paths, Chief Director vendor, exact saved model or native default, AV launcher, provider readiness, OMA result, and project MCP installation. State whether an `av_missions` check actually ran. List concrete pending actions such as login, reload, trust, or a conflicting file. Distinguish local setup readiness from client connection readiness. Never claim a mission, deployment, remote account connection, or provider login that did not happen.

Explain the default interaction: the user gives a goal; the Chief Director decides skills, task assignments, implementation, reviews, repairs, and replanning within that goal and the available permissions. Its report explains those decisions, their reasons, actual results, and verification evidence. Preserve the user's chosen Chief Director vendor/model and acceptance criteria.

Include a short token usage warning: AV pursues service, refactoring, usability, and revenue goals with installed OMA skills and Director personas. It prioritizes the user's goal over token savings, and repeated model calls can consume substantial usage or incur API charges. AV does not check or manage the subscription's remaining allowance; optional estimated-cost limits and execution limits still apply. A completed order finishes; continued operation requires subsequent orders or tracker work. This explanation does not authorize starting a mission during setup.

Further reference: [environment setup](./docs/guides/environment-setup.md), [agent clients](./docs/guides/agent-clients.md), and [native plugins](./docs/guides/native-plugins.md). The procedure above is self-contained; these guides explain optional operation after setup.
