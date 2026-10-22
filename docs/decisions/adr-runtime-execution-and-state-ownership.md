# Runtime execution and state ownership

Date: 2026-10-23
Status: Proposed, revision 2. Local runtime changes and an independent, opt-in A2A backend are implemented under the user's implementation request. Production endpoint qualification and the economic assessment remain open.

## Context and evidence

The supplied `Agent_Valley_ATAM_CBAM_ADR.md` reconstructs a historical recommendation to retain AV state authority, refactor execution and evaluate A2A. Its original numerical CBAM model is unavailable. It does not establish that a framework replacement is necessary.

This review uses repository baseline `f213d150678ec6480c5a6b95c77d24f278919730`. Current code already has durable Mission JSON, execution budgets, process identity checks, recovery of orphaned local processes, and reconciliation of uncertain external effects. LangGraph routes Chief stages through `coordinator-graph.ts`; AV stages and `MissionStore` own domain transitions and checkpoints. [0001](0001-turso-team-ledger.md) remains in effect.

The concrete gaps are narrower: Chief bypasses the existing `AgentRunnerPort`; the spawn adapter loses lifecycle events emitted before subscription, reports completed handles as alive, and omits the full execution result. Local process cleanup must finish before a reviewer reads the workspace. A future runtime that continues after a coordinator restart also needs a durable barrier against resubmission.

## Options

| Option | Benefit | Cost and risk | Disposition |
| --- | --- | --- | --- |
| Keep direct Chief process orchestration | No migration work | Two execution contracts; port consumers lose early completion and accurate liveness | Reject for the local path |
| Extend the existing execution port and preserve AV state ownership | Reuses one contract; exposes result, cancellation differences and uncertainty | Adapter lifecycle and concurrency tests; recovery schema extension | Implement local path |
| Expand LangGraph persistence or replace the core with Mastra | Potential framework facilities | No demonstrated missing capability; changes checkpoint ownership and migration scope | Defer |
| Add an independent A2A backend with explicit endpoint and artifact contracts | Remote interoperability through the existing execution port | Durable remote records, constrained file delivery, trusted local verification and endpoint qualification | Implement as an opt-in backend; qualify each production endpoint separately |

These are qualitative comparisons, not measured return on investment. Reconsider the backend choice when a concrete remote workload and comparable implementation/operating costs are available.

## Contract and ownership

| Concern | Authority |
| --- | --- |
| Mission/task transitions, budgets, retries, checkpoints | AV coordinator and `MissionStore` |
| Stage routing | LangGraph adapter; it does not own Mission persistence |
| Execution observation, result and intervention capabilities | `AgentRunnerPort` and its runtime adapter |
| Local PID identity, process groups and disposal | Local adapter and process guard |
| Applying changes, workspace fingerprint, review and final verification | Existing AV delivery and verification gates |
| Unknown execution outcome and operator reconciliation | Durable AV execution record; never a transport retry decision |
| Independent A2A request, remote reference and artifact application journal | AV execution service and `A2aJobStore`; remote Task state is an observation |

`RunHandle.result` carries the full `RunAttempt`, including output and observed usage. `AgentRunError` retains the observed attempt and explicitly marks an unknown outcome. A local result settles after that attempt's startup and cleanup have joined. Cancelling one attempt must not stop another attempt sharing a service.

Cancellation, force-stop and reconnect support are explicit capabilities. A remote cancellation acknowledgement or an expired network connection does not establish that a writer has stopped. Callers must pause when stop confirmation is unavailable.

Run records distinguish execution state from review outcome. New injected runtimes require reconciliation after an interrupted dispatch unless their recovery is explicitly bound to AV's local process guards. Legacy local records remain readable. Unknown executions survive restart and prevent dispatch until reconciled.

`reconcileExecution` accepts explicit termination evidence and records its
authority in history. It settles the execution as failed without approving a
task, resolving its external effects or inventing billing data. Local recovery
may use a matching process marker that was successfully cleared; missing markers
and nonlocal runs require separate evidence. The helper does not authenticate
remote evidence. `av missions reconcile` exposes operator-recorded termination
evidence for Mission runs and leaves the Mission paused. Operation decision
checkpoints have their own recovery policy; this command covers Missions,
including operation child Missions.

`av a2a run/resume/status/reconcile` uses the same execution port as local
execution and owns separate records under `.agent-valley/a2a/`. It does not
change Chief's native actor selection or make a remote result a completed
Mission. The endpoint JSON selects an explicitly trusted JSON-RPC interface
and names an optional Bearer-token environment variable. AV persists the exact
input and a request digest before `SendMessage`, then the Task/context reference
before polling. A lost submission response without a Task ID remains unknown;
`resume` cannot send it again. An accepted Task is resumed with `GetTask`.

The file contract is an inline `agentValleyArtifact` manifest bound to the
attempt, request digest, repository identity and base revision. The operator
supplies exact allowed paths and a fixed verification command. AV validates
bounded complete file bytes and hashes, refuses credential/metadata paths and
symlinks, journals changes before applying them, and checks interrupted
application against original or desired file images. It then runs the local
verifier and rechecks HEAD, delivered files and the workspace fingerprint.
Neither a remote success claim nor an unconfirmed verifier process cleanup
allows another execution. See [A2A execution](../guides/a2a-execution.md).

## Diagram

```mermaid
flowchart LR
    graph[LangGraph stage routing] --> coordinator[AV coordinator]
    coordinator --> store[MissionStore]
    coordinator --> runtime[ChiefRuntime]
    runtime --> port[AgentRunnerPort]
    port --> local[Local spawn adapter]
    local --> process[Local process guard and service]
    execution[A2A execution service] --> port
    execution --> jobs[A2aJobStore]
    port --> a2a[A2A adapter]
    a2a --> endpoint[Remote endpoint]
    execution --> gate[Artifact and verification gate]
    gate --> jobs
```

Interactive: [adr-runtime-execution-and-state-ownership.archify.html](./adr-runtime-execution-and-state-ownership.archify.html)

## Validation

| Scenario | Acceptance evidence |
| --- | --- |
| Actor completes while `spawn` is returning | A later subscriber receives ordered start and terminal events; result retains output/usage; liveness becomes false |
| Cancellation races delayed session startup | No result or reviewer access before the late process has been disposed |
| A terminal message races natural process exit | Reconcile transient cleanup errors only with proof that the full process group stopped; retain uncertainty on a live group's permission denial |
| Two attempts share a service | Cancelling one joins only its cleanup; the other remains active |
| Runtime reports an unknown submission/stop result | Mission pauses; no retry, review or verification dispatch follows |
| Coordinator restarts with a reconciliation-required run | Durable record remains uncertain; unfinished work is not silently reset for replay |
| External package enters domain, or LangChain enters a module outside the routing adapter | `bun run check:imports` fails |
| A2A accepts a submission and loses its response | Persisted uncertainty blocks another submission; taskless `resume` never calls `SendMessage` |
| AV restarts with a saved A2A Task reference | A new service instance uses `GetTask` and the original execution identity; no replacement submission |
| Remote artifacts are tampered, stale or escape the allowed paths | Hash/binding/path/symlink checks reject them before application; partial application resumes only from recorded file images |
| A remote success claim conflicts with local verification | The execution remains failed; explicit resume rechecks the saved response without submitting again |
| Local verification cannot confirm process cleanup | The execution remains unknown and blocks another repository writer |

Run `bun run test`, `bun run typecheck`, `bun run lint` and `bun run check:imports`; the repository coverage thresholds remain applicable. These checks include an actual local HTTP JSON-RPC fixture and real Git/file/verification operations. They do not certify a production A2A endpoint. The separate native-agent interruption/restart smoke requires the local runtime gate's owner approval; its result must be reported independently of automated fixtures.

## Remote backend gates

1. Select an endpoint and protocol version, and define remote status/event mapping to AV observations. AV retains Mission authority.
2. Persist an execution key, request digest, endpoint identity and attempt before submission; retain a remote task/context reference once known. Prove response-loss recovery without blind resubmission, including the case where no task ID was received.
3. Demonstrate restart/reconnect, duplicate/out-of-order event handling and polling fallback. Confirm terminal state before allowing another writer or reviewer after cancellation.
4. Bind returned changes to mission, attempt, repository, base revision and artifact digest. Validate bounded manifests/paths/symlinks in isolation; reuse AV's delivery checks and recompute the integrated workspace fingerprint.
5. Re-run the trusted verification contract on the integrated tree. Remote success text and test claims do not independently satisfy AV's gate.
6. Verify endpoint trust, HTTPS, scoped authentication/authorization, credential redaction, redirects/SSRF and payload limits through an approved adapter.
7. Test the selected endpoint's response loss, restart, cancellation and artifact tampering. Agree operational recovery targets and estimate maintenance and operating costs before adoption.

The [A2A v1.0.1 specification, sections 3.1.5 and 3.3.1](https://a2a-protocol.org/v1.0.1/specification/) allows message deduplication but does not require it; task cancellation is a request whose success is not guaranteed. The backend must establish its own execution-safety guarantees.

## Transition and consequences

First extend the existing port, then route Chief's default local execution through its adapter. Preserve local process guards, budgets, OMA receipt checks and delivery verification. Read old records as local; save the new execution metadata for new runs. Test injected executions without PIDs, cleanup races and restart barriers before enabling another backend.

The A2A backend is independent and opt-in. It adds no framework dependency and
does not upload repository contents, inherit a remote Agent Card's endpoint, or
automatically route Chief stages to a remote service. Production use requires
an authorized endpoint with access to the intended repository revision, exact
file permissions and a trusted verifier kept outside the allowed delivery
paths. Remote artifact URLs are not fetched. Only the approved adapter makes
remote calls; redirects and unbounded responses are rejected. Each deployment
still needs its own authorization and operating-cost evidence.

Mastra may be evaluated as an external agent/runtime when a workload warrants
it. LangGraph remains limited to routing. Removing or expanding it requires
behavior and recovery evidence.

The tradeoff is additional lifecycle and uncertainty handling in exchange for one reusable execution boundary. A conservative uncertainty pause may require operator investigation. Do not remove that barrier merely to restore automatic progress.
