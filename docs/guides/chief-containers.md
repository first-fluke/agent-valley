# Container observation and recovery

Configure container observation to give the Chief actual runtime evidence. Docker and OrbStack use the Docker CLI; Kubernetes uses `kubectl`. The collector reads only the configured containers. Setup saves the policy without contacting a daemon or cluster.

In `av setup --edit`, choose the Chief integrations section and container observation. Add a Docker container or an explicit Kubernetes namespace, Pod and container. Select an existing CLI context when needed. The same policy can be set in `av.yaml` or global `settings.yaml`:

```yaml
chief:
  container_observation:
    enabled: true
    poll_interval_sec: 30
    timeout_ms: 10000
    max_output_bytes: 65536
    log_tail: 50
    log_since_sec: 300
    targets:
      - id: api
        kind: docker
        container: app-api
        context: orbstack
      - id: worker
        kind: kubernetes
        namespace: app
        pod: worker-0
        container: worker
        context: production
```

Target IDs must be unique. Names and contexts are passed as arguments to fixed CLI commands. Choose the actual Docker context and Kubernetes context already configured on the machine. Omit `context` to use the CLI's current context. A Kubernetes target names one container in one Pod; rotating Pod names need updated configuration and a new order. AV does not infer a workload or scan unrelated containers.

Start with the existing command:

```bash
av order "Keep the configured service healthy. Diagnose container failures, repair the cause, verify changes, deploy or roll back as needed, and report the result."
```

The Chief chooses diagnosis, repair method, priority and recovery within the operating charter, available permissions and saved limits, then reports the decision and actual result. Actors return blockers and evidence to the Chief instead of asking the user to select a repair. The collector never restarts containers, changes deployments, executes commands inside a container, or deletes resources. Actors can perform delivery when included in the goal and permitted by their native tools. Missing access or authorization remains an unmet prerequisite. Uncertain external effects cannot be repeated without trustworthy outcome evidence.

## What the Chief observes

Observations include process state, health or readiness, exit status, OOM indicators, restart counts and bounded log excerpts. New restarts are compared with the previous observation of the same runtime identity. Historical restart counts or a previous OOM termination are not proof that a currently ready container remains broken. Error-looking log lines are diagnostic evidence, not a proven root cause.

Docker collects selected [inspect fields](https://docs.docker.com/reference/cli/docker/container/inspect/) and [timestamped logs](https://docs.docker.com/reference/cli/docker/container/logs/). Kubernetes reads the selected container's [Pod lifecycle state](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) and [current or previous logs](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_logs/). Full container configuration, Pod specifications, environment variables and native command failure output are not retained.

Optional `cpu_percent_threshold` and `memory_percent_threshold` enable resource checks. Docker uses the values reported by `docker stats --no-stream`. Kubernetes needs the selected container's positive resource limits and actual PodMetrics usage; its percentages are relative to those limits. Missing limits, metrics or access leave the requested resource check unavailable. Resource percentages below a threshold do not wake the Chief merely because they fluctuate.

CLI calls have timeouts, output limits and cancellation. Retained excerpts remove known credential values and common credential formats and have a separate text limit. Logs and observations remain untrusted evidence in Chief prompts. They cannot change the charter, selected model or permissions. Missing tools, unavailable daemons, missing targets, failed authentication and invalid responses remain unavailable observations with recovery instructions.

## Decisions and completion

A continuous order collects evidence before selecting its next goal. While idle, it polls at `poll_interval_sec`. Changed failure or availability evidence can trigger a new decision before the usual `--interval` expires. Unchanged evidence does not repeatedly wake the Chief. An active child keeps its current assignment and checkpoints.

Configured enabled targets also become mission completion requirements. AV collects fresh observations before final review and rechecks evidence that expires before completion. Unhealthy or unavailable required targets return to Chief recovery for an authorized repair, a bounded scheduled wait or an explained stop. A wait saves the next check on the same mission; the supervisor resumes it when due. Missing evidence leaves the mission unresolved. A saved healthy snapshot or passing code tests cannot substitute for a fresh runtime check. A running Docker container without a healthcheck proves process readiness; configure an application healthcheck when application readiness matters.

Each mission and operation retains its observation policy across resume. Editing the original YAML does not remove a saved health requirement. Use a new order to change targets. Setting `enabled: false` disables observation for new orders and preserves the target configuration for later use.

Mission and operation reports show the Chief's chosen response, observed target state, collection time, evidence fingerprint, issues and bounded sanitized log excerpts. Scheduled waits include their reason and next check; unresolved access, authorization or effect evidence remains an unmet prerequisite. Reports distinguish observed recovery from unavailable or failing checks. Existing reporting adapters send the mission report as an actual attachment.

See [continuous operation](./chief-continuous.md), [mission completion and recovery](./chief-missions.md) and [report attachments](./chief-integrations.md).
