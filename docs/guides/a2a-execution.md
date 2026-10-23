# Remote A2A execution

`av a2a` submits a bounded code task to an explicit remote endpoint. AV owns the saved request, local artifact application and verification result. The endpoint must already have authorized access to the requested repository revision; AV does not upload repository files or credentials.

The backend implements the execution port independently of Chief roster selection. Use `av a2a` to select a remote endpoint; Chief rosters do not select A2A automatically. The supported protocol specification is 1.0.1, with JSON-RPC wire version `1.0`.

Run from the root of a clean Git repository, or pass its absolute path with `--workspace`. Returned files are applied there. The command does not create a branch or commit. Existing unresolved executions block another submission in the same repository.

## Endpoint configuration

Save an endpoint JSON file:

```json
{
  "id": "remote-agent",
  "url": "https://agent.example/rpc",
  "authTokenEnv": "AV_A2A_TOKEN",
  "requestTimeoutMs": 30000,
  "pollIntervalMs": 1000
}
```

Keep this file outside the repository, or commit its nonsecret configuration before starting. An untracked endpoint or prompt file inside the repository makes it dirty.

Set the named environment variable through your normal credential mechanism before connecting. The JSON stores its name. Inline token fields are rejected. Endpoint URLs require HTTPS and cannot include credentials, a query or a fragment. Agent Card discovery stays on the pinned endpoint origin; `agentCardUrl` can select another path on that origin. HTTP is available only for explicit development loopback configuration with `allowHttpLoopback: true` and a literal `127.0.0.1` or `[::1]` host.

The strict endpoint schema also accepts `tenant` and `maxResponseBytes`. Unknown fields are rejected. The JSON file limit is 65,536 bytes.

Endpoint and prompt inputs must be regular files. Directories, devices and
named pipes are rejected without waiting for a writer.

## Submit and inspect

```bash
av a2a run 'Repair the greeting and document its behavior' \
  --endpoint /outside/repository/endpoint.json \
  --allow src/greeting.ts \
  --allow docs/greeting.md \
  --verify 'node scripts/verify-greeting.cjs'
```

For a longer goal, supply a UTF-8 file instead of the goal argument:

```bash
av a2a run --prompt-file /outside/repository/task.txt \
  --endpoint /outside/repository/endpoint.json \
  --allow src/greeting.ts \
  --verify 'node scripts/verify-greeting.cjs' \
  --workspace /absolute/path/to/repository \
  --timeout 600
```

Provide exactly one goal source, at least one `--allow`, and a trusted local `--verify` command. Goals have a 64,000-character limit. `--timeout` defaults to 600 seconds, with a range of 1–86,400; the saved limit is used for remote execution and local verification. Endpoint and prompt file paths are relative to the invoking directory. Allowed paths are exact files relative to the target repository, without globs.

Keep the verifier's code, tests and configuration outside the delivery allowlist. In these examples, `scripts/verify-greeting.cjs` is an existing trusted check that the remote task cannot replace.

The command prints the execution ID after saving its initial record and before network submission. Keep that ID:

```bash
av a2a status
av a2a status EXECUTION_ID
av a2a resume EXECUTION_ID
```

These commands also accept `--workspace /absolute/path/to/repository`. Status prints IDs, state and verification status; it does not dump prompts, credentials, verification output or reconciliation evidence. Records are stored under `.agent-valley/a2a/` in the target repository.

## Interruptions and uncertain outcomes

Ctrl-C or SIGTERM requests cancellation and allows the service to retain its checkpoint. A cancellation request or lost HTTP response cannot establish that remote work stopped.

Resume retains the endpoint, goal, request binding, allowed paths and verifier. An accepted task with a saved remote task ID is fetched again without submitting another task. A saved terminal response can be verified locally again. A submission whose acceptance is uncertain and has no task ID remains blocked for reconciliation.

Resuming another saved execution cannot bypass this repository's unresolved
execution barrier. Reconcile or resume the blocking execution first. If
cancellation arrives before transmission, AV retains a checkpoint proving no
request was sent. Once a Task reference has been received, it is saved before
cancellation proceeds. Local artifact application and verification also honor
cancellation; inspect their saved receipts because an interruption can leave
partially applied files.

After independently confirming termination, record the evidence:

```bash
av a2a reconcile EXECUTION_ID \
  --evidence 'The remote task is terminated; inspected its final status and runtime logs.'
```

Evidence must contain 1–2,000 characters. Reconciliation records termination and leaves the execution `reconciled`; it does not declare successful work or resubmit the request. A missing task or HTTP 404 alone does not prove that work was never accepted. Check any external effects separately before authorizing another execution.

Completed executions return exit code 0. Failed or otherwise incomplete executions, including `unknown` and `reconciled`, return exit code 1. An empty status listing returns 0. The CLI does not force the process to exit while cleanup is pending.

## Artifact response contract

The remote result must contain exactly one inline A2A data Part with this envelope. Replace the placeholders with the request's exact binding values:

```json
{
  "data": {
    "agentValleyArtifact": {
      "version": 1,
      "attemptId": "<execution ID from the request>",
      "requestSha256": "<message.metadata.agentValley.requestSha256>",
      "repositoryId": "<repository ID from the request>",
      "baseRevision": "<base Git revision from the request>",
      "files": [
        {
          "path": "src/greeting.ts",
          "contentBase64": "<canonical base64 of complete file bytes>",
          "sha256": "<SHA-256 of the decoded bytes>",
          "executable": false
        }
      ]
    }
  }
}
```

Use `contentBase64: null` and `sha256: null` to delete an allowed file. The envelope supports 1–100 files, at most 1 MiB per file and 4 MiB total. Paths must be literal relative product files using ASCII letters, digits, `.`, `_`, `-` and `/`. Credentials, agent instructions, runtime state, symlinks and paths outside the allowlist are rejected. Remote URL and raw-byte Parts are rejected.

AV checks the execution, request, repository and base revision bindings and hashes the decoded bytes. It journals file application so interrupted local work can be reconciled against the saved response. Successful completion requires the fixed local verifier to pass, the original Git HEAD to remain unchanged, and every delivered file and the artifact fingerprint to match after verification.
