# SAFETY.md — Safety Rails

> Agents act fast. Without boundaries, they act fast in the wrong direction.
> Safety rails are the structure that maintains agent speed while limiting the blast radius.

---

## 1. Principle of Least Privilege

Grant agents only the minimum privileges required to perform their tasks.
The broader the privileges, the larger the blast radius of a mistake.

### File System

- An agent can only write to its own workspace directory (`{WORKSPACE_ROOT}/{key}`)
- Access to another issue's workspace path is not allowed
- Direct modification of the repository root is not allowed (only through PRs)

### Linear API

- An agent can only change the state of the issue it is responsible for
- Attempts to change another issue's state are immediately rejected + logged
- No permission to delete issues

### Git

- An agent can only push to its own branch (`issue/{key}`)
- Direct push to `main` or `master` is not allowed
- Force push is not allowed

### Secret Management

API keys and tokens must never be included in code, logs, or commits.

- All secrets are stored only in `.env` (must be registered in `.gitignore`)
- If a secret pattern is detected in agent-generated files, the commit is blocked
- `.env.example` contains only key names and descriptions, no actual values

---

## 2. Network Egress Control

If an agent calls an unapproved external service, data leakage and unpredictable side effects can occur.

### Approved Endpoints

| Service | Endpoint | Purpose |
|---|---|---|
| Linear | `https://api.linear.app/graphql` | Issue queries + state changes |
| Codex server | `localhost:{port}` (local) | Agent execution |

### Handling Unapproved External Calls

When an HTTP request is made to an unapproved endpoint:

1. Immediately block the request
2. Record in the audit log (timestamp, attempted URL, agent ID, issue key)
3. Deliver error event to the Orchestrator -> fail the corresponding RunAttempt

### Adapter Pattern

All external calls go through approved adapters.
Agents are prohibited from making direct external network calls.

```
Agent -> Issue Tracker Client (adapter) -> Linear API
Agent -> Agent Runner (adapter) -> Codex server
```

(See `AGENTS.md` Section Architecture Overview — component boundaries)

### OS-Level Sandbox for Spawned Agents (v0.2+)

Every agent CLI (claude/codex/gemini) runs non-interactive with its own
permission-bypass flag (`--dangerously-skip-permissions`, `approvalPolicy:
"never"`, `--yolo`) — there is no TTY to answer prompts. That flag alone
would give a prompt-injected issue body full shell/filesystem/network
access to the host. `packages/core/src/sessions/sandbox.ts` routes every
spawn through an OS-level sandbox so containment comes from the kernel:

- **macOS:** Seatbelt via `sandbox-exec`.
- **Linux:** bubblewrap via `bwrap` — filesystem confinement only.
- **Fail-closed default:** if no sandbox binary is available for the
  current platform, the spawn is refused with an actionable error
  instead of falling back to unsandboxed execution.

| Env var | Effect |
|---|---|
| `SYMPHONY_ALLOW_UNSANDBOXED=1` | Opt-in escape hatch: run without an OS sandbox when one isn't available on the host. NOT the default. Every unsandboxed spawn logs a loud WARN naming exactly what's missing and what it grants (full host filesystem + network access to a prompt-injected issue body). Set in the orchestrator process environment, not in `valley.yaml`. |
| `SYMPHONY_SANDBOX_NETWORK_ALLOWLIST` | Comma-separated extra hostnames appended to the default egress allowlist (`api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `github.com`, `api.github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `registry.npmjs.org`). See the residual gap below — this allowlist is not fully enforced on macOS. |

**Residual gaps (tracked, not silent shortfalls):**

1. **Network egress is port-scoped, not domain-scoped.** On macOS,
   `sandbox-exec`'s profile grammar only accepts `*` (any host) or
   `localhost` in `(remote tcp ...)` rules — it cannot filter by literal
   hostname. The sandbox therefore allows outbound TCP on ports 443/80 to
   *any* host, which blocks raw-socket exfiltration/backdoor ports but
   cannot stop HTTPS traffic to an attacker-controlled domain. On Linux,
   `bwrap` enforces filesystem confinement only — network egress is not
   restricted at all on that platform. Real domain-scoped enforcement
   would require a local forwarding proxy (not implemented).
2. **Most credential files are readable inside the sandbox — a curated
   denylist is excluded.** Both platforms grant broad filesystem READ
   (macOS: most of the host; Linux: a read-only view of `$HOME`) so
   language toolchains keep working. `packages/core/src/sessions/
   sandbox-darwin.ts` and `sandbox-linux.ts` now carve out an explicit
   denylist from that broad read (macOS: `(deny file-read* ...)` rules
   placed after the broad allow, exploiting Seatbelt's last-match-wins
   evaluation; Linux: `--tmpfs`/`--ro-bind /dev/null` masks layered over
   the read-only `$HOME` bind) covering `~/.config/agent-valley`
   (LINEAR_API_KEY + other orchestrator secrets in settings.yaml), the
   project's `valley.yaml` (team webhook secret, Linear team id/uuid —
   masked on a best-effort basis, resolved from the orchestrator's cwd),
   `~/.ssh`, and `~/.git-credentials`. SSH-based git auth is unaffected
   since it goes through the already-allowed ssh-agent unix-domain
   socket rather than reading private key files directly. This denylist
   is NOT exhaustive: cloud CLI credential caches (e.g. `~/.aws`,
   `~/.config/gcloud`) and other tools' dotfiles under `$HOME` remain
   readable by the sandboxed process — combined with the allowed HTTPS
   egress above, a compromised agent process could still read and
   exfiltrate those even though filesystem *writes* stay confined to the
   workspace directory + the curated per-agent-CLI write allowlist (which
   no longer includes a blanket `~/.config`, for the same reason).

---

## 3. Prompt Injection Defense

External inputs may contain malicious instructions.
If an agent inserts issue body text directly into a prompt,
the issue author can arbitrarily manipulate agent behavior.

### Trust Level Classification

| Source | Trust Level | Reason |
|---|---|---|
| `WORKFLOW.md` | Trusted | Version-controlled, written by engineers |
| `AGENTS.md`, `docs/` | Trusted | Verified files within the repository |
| Issue body | Suspect | External input, cannot be verified |
| Issue comments | Suspect | External input, cannot be verified |
| PR description | Suspect | May be external input |

### Defense Rules

**Prohibited:** Inserting external input directly into prompts

```python
# Dangerous — prohibited
prompt = f"Process the following issue: {issue.description}"

# Safe — escape or pass as structured fields
prompt = build_prompt(issue_id=issue.id, title=issue.title)
```

**Implementation Rules:**

1. Issue body is passed to prompts only as structured fields (`issue.id`, `issue.title`)
2. Free-text fields must be escaped and isolated in a sandboxed area
3. Values extracted from issue body must not be interpreted as system instructions
4. Validate once at the entry point; internal components are trusted (see `AGENTS.md` Section Conventions — validate at the boundary)

**Boundary sanitizer implementation (`packages/core/src/config/workflow-loader.ts`):**

Untrusted title/description/retry-reason text passes through two layered,
individually incomplete mitigations before it reaches a prompt:

1. **Spotlighting (primary defense).** `wrapUntrustedContent` wraps the
   sanitized text in explicit, labeled delimiters (`<<<UNTRUSTED_ISSUE_CONTENT
   ...>>>` / `END_UNTRUSTED_ISSUE_CONTENT>>>`) with an inline preamble
   instructing the model to treat the enclosed content as data, never as
   instructions. Any literal occurrence of the delimiter tokens — or a
   generic `<<<`/`>>>` bracket run of the same shape — inside the untrusted
   text is neutralized first, so an issue body cannot forge its own closing
   marker and "break out" of the block. This structural mitigation does not
   depend on recognizing specific phrasing and is far more robust than
   pattern matching.
2. **Normalized blocklist matching (secondary signal).** `sanitizeIssueBody`
   strips invisible/control characters (zero-width spaces/joiners, bidi
   overrides, the BOM) and applies Unicode NFKC normalization before
   redacting known injection phrasing, so trivial evasions like an
   injected zero-width space splitting "ignore​previous​instructions"
   no longer defeat the `\s+`-based patterns. It does **not** catch
   cross-script homoglyphs (e.g. Cyrillic look-alike letters) or novel
   paraphrasing — a blocklist can never be complete against an adaptive
   adversary.

Neither mechanism is a security boundary on its own, and this module does
not claim to be one. **The actual containment boundary is the OS-level
sandbox** (`packages/core/src/sessions/sandbox.ts`, §1 above): it limits
what a fully compromised agent process can do to the host regardless of
what text made it into the prompt. This sanitizer exists to reduce the
odds that an agent *decides* to act on injected instructions, not to
guarantee it can't.

---

## 4. Dashboard / Intervention Endpoint Auth (v0.2+)

`/api/status`, `/api/events`, and `/api/intervention` (dashboard-auth.ts)
are localhost-only by default: the handler applies a best-effort
"looks local" check on the `Host` header (plus `X-Forwarded-For`, since
ngrok fronts the dashboard by default). This heuristic is a dev
convenience only — the `Host` header is attacker-controlled and forgeable
by anyone who can reach the bound port, and Next.js Route Handlers have
no access to the underlying socket to verify true local origin. The real
access control is a bearer token, enforced fail-closed:

| Env var | Endpoint(s) | Effect |
|---|---|---|
| `SYMPHONY_DASHBOARD_TOKEN` | `/api/status`, `/api/events` | When set, non-local requests must send `Authorization: Bearer <token>`. |
| `SYMPHONY_ALLOW_REMOTE_STATUS=1` | `/api/status`, `/api/events` | Opts the endpoints into remote access. Requires `SYMPHONY_DASHBOARD_TOKEN` to also be set — if the flag is on but no token is configured, **all** requests (including local ones) are rejected. Unauthenticated remote access is never permitted. |
| `SYMPHONY_INTERVENTION_TOKEN` | `/api/intervention` | Same pattern as `SYMPHONY_DASHBOARD_TOKEN`, scoped to the intervention endpoint (pause/resume/append_prompt/abort). |
| `SYMPHONY_ALLOW_REMOTE_INTERVENTION=1` | `/api/intervention` | Same pattern as `SYMPHONY_ALLOW_REMOTE_STATUS`, fail-closed without `SYMPHONY_INTERVENTION_TOKEN`. |

Policy order per request: (1) if the relevant `ALLOW_REMOTE` flag is set,
a matching token is mandatory — no token configured means the endpoint
rejects everything, local or remote; (2) otherwise, requests that look
local are allowed through; (3) otherwise, a configured token is checked
if present; (4) otherwise, the request is rejected as localhost-only.

---

## 5. Audit Logs

All agent actions must be traceable.
Without audit logs, it is impossible to determine the cause when problems occur.

### What to Record

- File writes (path, issue key)
- API calls (endpoint, method, response code)
- Issue state changes (previous state -> new state)
- Branch pushes
- Network blocking events

### Log Format

```json
{
  "ts": "2026-03-16T10:00:00Z",
  "level": "info",
  "event": "agent.action",
  "agent_id": "codex-worker-1",
  "issue_key": "ACR-42",
  "workspace": "/workspaces/ACR-42",
  "action": "api.call",
  "endpoint": "https://api.linear.app/graphql",
  "operation": "issueUpdate",
  "result": "success"
}
```

- Format: JSON (one line = one event)
- Timestamp: ISO 8601 (UTC)
- Structured log specification details: `docs/specs/observability.md`

### OpenTelemetry Tracing (v0.2+, optional)

When `observability.otel.enabled: true` (see `valley.example.yaml`),
`packages/core/src/observability/otel-exporter.ts` exports spans and
metrics via OTLP/HTTP JSON to the configured collector endpoint. Agent
invocation spans and token accounting follow the OpenTelemetry GenAI
semantic conventions (stable, v1.43.0): `gen_ai.*` span attributes plus a
`gen_ai.client.token.usage` histogram metric. Exporter errors (network
failures, non-2xx responses) are swallowed and counted via
`av_observability_errors_total{exporter="otel"}` — they never affect
orchestrator flow. Endpoint/service name resolve from valley.yaml first,
then fall back to the standard `OTEL_EXPORTER_OTLP_ENDPOINT` /
`OTEL_SERVICE_NAME` env vars, then to `agent-valley`.

### Retention Policy

- Minimum 30-day retention
- Cannot be deleted (append-only)
- Must never contain secrets (API keys, tokens)

---

## References

- `AGENTS.md` Section Security — security principles summary
- `AGENTS.md` Section Conventions — validate at the boundary principle
- `docs/specs/observability.md` — structured log specification
- `docs/harness/LEGIBILITY.md` — ephemeral observability stack
