# Chief operations and attachments

[Continuous operation](./chief-continuous.md) uses these observations and child reports to choose successive improvement goals. It also discovers local cloud/container CLIs and configured MCP metadata. Actor environment credentials can be forwarded explicitly with `chief.tool_env_keys`; discovery itself never confirms authentication.

`av order` records actual run duration, native token usage when supplied by the CLI, review outcomes and the vendor that performed each run. Missing usage and cost remain unknown. Configured token prices produce estimates, not billing receipts.

Automatic teams with multiple authenticated CLIs can route work between native defaults. A configured pool can also select models. Chief Director models and explicit model pins in supplied Actor rosters are preserved. After enough observations, routing selects a qualifying route with the lowest observed cost per accepted deliverable, including failed attempts. Before then it uses configured prices or candidate order. Failed or rejected routes can escalate within the existing task/recovery limits. AV does not download or guess model prices.

```yaml
chief:
  review_vendor: prefer # prefer | require | off
  memory: true
  routing:
    min_samples: 3
    min_success_rate: 0.8
    candidates:
      - actor_type: codex
        model: your-cheap-model
        # Supply input_per_million_usd/output_per_million_usd from your pricing.
      - actor_type: claude
        model: your-escalation-model
```

Task review selects a different ready vendor from the actual worker when available. `require` blocks work without such a reviewer; `prefer` records same-vendor fallbacks. Supplied rosters remain, with a review Actor added if needed. Final review remains the Chief Director's responsibility. New orders discover readiness; resume preserves it.

## Reconciling unknown run costs

A configured estimated-cost limit pauses when a finished or interrupted run has unknown cost. Inspect provider billing and use the run ID from the saved mission's `mission.operations.runs`:

```bash
av order --resume MISSION_ID --account-run RUN_ID --account-cost 0.25
# Explicit zero is accepted only when the operator has checked the charge.
av order --resume MISSION_ID --account-run RUN_ID --account-cost 0
```

Both flags are required. Accounting records a separate `operator-recorded` entry; native cost and unavailable token usage remain unknown. Every unresolved finished run needs an entry. Known estimates and reconciled amounts both count toward the limit, including failed attempts. Resuming preserves spent Actor calls, elapsed time and original acceptance checks; increase an exhausted limit separately with `--runs`, `--duration` or `--cost`. Configured-price estimates and operator records do not guarantee the final provider bill or reserve funds before a call.

## Organization and business evidence

Data is shared across mission worktrees in the original source repository's `.agent-valley/organization/`. Verified outcomes retain changed-file digests and execution observations. Actor prose never becomes an approved technical standard. Operators can record decisions and sourced observations:

```bash
av memory add "Use the existing PostgreSQL database" --kind stack-standard --tags database
av memory list
av metrics record conversion 4.2 --unit percent --source "Analytics export" --at 2026-10-03T00:00:00Z
av metrics list
av metrics import observations.json
av metrics experiment --file experiment.json
```

Metric imports are arrays of `{name,value,unit,source,timestamp,experimentId?}`. Experiment files use `{id,name,hypothesis,targets,beforeSampleIds,afterSampleIds,timestamp,adjudication?}`. Sample IDs come from `av metrics list`.

```yaml
chief:
  metric_targets:
    - name: conversion
      unit: percent
      direction: increase
      target: 5
```

Targets become fixed completion criteria. The coordinator reloads observations before final review and rejects missing or failing targets even if an Actor claims success. Without a numeric target, the latest observation must improve on a comparable baseline. Comparisons distinguish missing data and incompatible units. They do not establish causation or independently audit declared sources. No analytics account or campaign is connected automatically. Historical text is bounded and treated as evidence rather than instructions.

## Automatic business metric sources

In `av setup`, choose **Configure a business metric and target** in the optional integrations step. In `av setup --edit`, select **Reports, browser capture and business metrics** first. Choose HTTP JSON, a repository JSON file or Stripe charge revenue; enter the metric name, unit, target direction/value and observation limits. A blank target requires improvement over an actual measured baseline. The wizard saves environment variable names, preserves other metrics and reporting/capture settings, and does not fetch measurements or read credentials. Repeat the edit step to configure another metric.

Configure read-only collection in `chief.metric_sources`. HTTP endpoints and credentials are environment-variable references; JSON exports are regular files inside the original source repository. Each metric has one authoritative source. Source names must match `metric_targets`:

```yaml
chief:
  metric_targets:
    - name: signup-conversion
      unit: fraction
      direction: increase
      target: 0.2
  metric_sources:
    observation_window_ms: 60000
    max_observation_ms: 3600000
    sources:
      - id: signup-api
        name: signup-conversion
        unit: fraction
        adapter: http-json
        url_env: AV_ANALYTICS_URL
        token_env: AV_ANALYTICS_TOKEN
        value_path: conversion.value
        timestamp_path: conversion.timestamp
        unit_path: conversion.unit
        max_age_ms: 300000
        poll_interval_ms: 60000
        timeout_ms: 10000
```

The endpoint receives a GET with an optional bearer token and returns measured numeric data, for example:

```json
{"conversion":{"value":0.24,"unit":"fraction","timestamp":"2026-10-03T00:02:00Z"}}
```

`json-file` reads the same payload with `file: analytics/metrics.json`; it needs no endpoint or token. Dot-separated paths support array indexes. Optional `window_start_path` and `window_end_path` preserve a measured window. Responses and exports are bounded to 2 MB. HTTP uses HTTPS, with HTTP allowed on localhost. Redirects, embedded URL credentials, repository escapes and file/directory symlinks are rejected. Applications inject custom adapters through `createMetricSourceRegistry` and `MetricCollectionDependencies.registry`.

AV collects a pre-work baseline and preserves its sample ID across resume. After deliverable verification it waits for fresh source-collected observations measured after the saved observation start and the configured observation window. A measured window must start after observation begins; older rolling-window data does not pass early. Numeric thresholds use the fresh current value; improvement-only goals require the pinned baseline and comparable window durations. Complete measurements below the target return to Chief recovery; missing, stale or unavailable observations wait only up to `max_observation_ms`. Imported/manual observations and historical successful values do not satisfy this automatic observation period. `memory: false` retains metrics while excluding organization memory and outcome history from Chief context.

The native `stripe-revenue` adapter reads [paginated live charges](https://docs.stripe.com/api/charges/list) and sums [captured amounts less refunds](https://docs.stripe.com/api/charges/object) for the selected charge-creation window, excluding unpaid, uncaptured, disputed and other-currency charges:

```yaml
chief:
  metric_sources:
    observation_window_ms: 86400000
    max_observation_ms: 259200000
    sources:
      - id: stripe-sales
        adapter: stripe-revenue
        name: daily-revenue
        unit: USD
        currency: USD
        token_env: AV_STRIPE_READ_KEY
        window_ms: 86400000
        poll_interval_ms: 300000
```

Set a matching `daily-revenue` target and a [live restricted API key with charge-read permission](https://docs.stripe.com/api/authentication). Supported currencies are USD, EUR, GBP, AUD and CAD. Test credentials/data cannot satisfy business goals. Empty complete live responses record actual zero; incomplete pagination does not record a partial total. The adapter measures charge-cohort revenue, excluding Stripe fees and settlement accounting; it does not measure profit or prove causal impact. Collection records source ID, timestamp, unit and window without retaining API responses, endpoints or tokens. Live analytics/Stripe accounts still require configured access; verification uses mocked providers.

The default mission duration is 86,400 seconds, including waiting time. Stripe's default measurement window is also 86,400 seconds, so work time can exhaust the mission limit before the first comparable post-work measurement. Set `chief.execution.max_duration_sec` or `av order --duration SECONDS` to cover work plus the required measurement and observation windows. Setup does not increase the execution limit automatically.

## Replaceable reporting channels

Set `chief.reporting` in `av.yaml` or global `settings.yaml`. Project blocks override matching global blocks. Multiple destinations receive terminal results independently. YAML stores environment-variable names:

```yaml
chief:
  reporting:
    events: [completed, failed]
    timeout_ms: 10000
    max_attempts: 3
    destinations:
      - id: team
        channel: slack
        token_env: AV_SLACK_TOKEN
        channel_id_env: AV_SLACK_CHANNEL
      - id: updates
        channel: discord
        url_env: AV_DISCORD_WEBHOOK
      - id: personal
        channel: telegram
        token_env: AV_TELEGRAM_TOKEN
        chat_id_env: AV_TELEGRAM_CHAT
```

The CLI sends readable text and an actual Markdown report attachment. Captured PNGs, the timestamp manifest and an encoded MP4 are also uploaded as files. Local paths do not substitute for uploads.

| Channel | Attachment configuration | Native operation |
| --- | --- | --- |
| Slack | `token_env`, `channel_id_env` | [External file upload](https://docs.slack.dev/reference/methods/files.getUploadURLExternal/) and [completion shared to the channel](https://docs.slack.dev/reference/methods/files.completeUploadExternal/) |
| Discord | `url_env` | [Multipart webhook upload with `wait=true` message confirmation](https://docs.discord.com/developers/resources/webhook#execute-webhook) |
| Telegram | `token_env`, `chat_id_env` | Bot [photo](https://core.telegram.org/bots/api#sendphoto), [video](https://core.telegram.org/bots/api#sendvideo) or [document](https://core.telegram.org/bots/api#senddocument) upload |
| Teams | `token_env`, `team_id_env`, `channel_id_env`, `drive_id_env` | Upload to the [channel's files folder](https://learn.microsoft.com/en-us/graph/api/channel-get-filesfolder?view=graph-rest-1.0) and send a [native file attachment](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0) |
| Google Chat | `token_env`, `space_env` | [Media upload and message attachment](https://developers.google.com/workspace/chat/upload-media-attachments); the space value is `spaces/SPACE_ID` |
| Mattermost | `token_env`, `base_url_env`, `channel_id_env` | [File upload](https://docs.mattermost.com/api/reference/upload-file) and [post with file IDs](https://docs.mattermost.com/api/reference/create-post); the base URL is the HTTPS server origin |
| Webhook | `url_env`, optional `token_env` | Multipart `files` bytes and JSON `payload_json` |

Slack requires `files:write` and channel access; text delivery through its bot token also requires [`chat:write`](https://docs.slack.dev/reference/methods/chat.postMessage/). An optional `url_env` uses an incoming webhook for text while the token uploads files. Teams requires a delegated Graph token with [`ChannelMessage.Send`](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0) and permission to read and [write the channel's files](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0); application-only migration tokens do not send ordinary channel messages. Google Chat file upload requires a [user OAuth token with `chat.messages.create` or `chat.messages`](https://developers.google.com/workspace/chat/api/reference/rest/v1/media/upload). Incoming text webhooks alone cannot upload native files for Slack, Teams, Google Chat or Mattermost. Missing attachment credentials leave delivery pending. Provider limits apply; this Telegram adapter permits uploads up to 50 MB.

Generic webhook receivers must store and display received bytes. A successful response confirms receipt; AV cannot verify the receiver's user interface. Native adapters provide the supported services' file attachment flow. Receivers can deduplicate the `Idempotency-Key` header.

Files are checked against the capture directory, recorded size and SHA-256 before upload or retry. Secrets are resolved at send time and omitted from saved receipts. A destination succeeds after all report parts and files succeed. Interrupted sends checkpoint the next unsent part:

```bash
av reports list
av reports retry
```

Retries use saved bytes without running Actors. Changing a destination resets progress for a complete resend to the new destination. Delivery failure does not invalidate verified work. A lost response after provider acceptance can cause a duplicate on retry because provider APIs do not all offer idempotent uploads.

Applications extend or replace channels through `ReportChannelPort` and an injected `ReportChannelRegistry` in `dispatchMissionReport`/`retryPendingReports`. YAML channel names are registry keys; mission coordination does not require a new branch.

## Aside capture

```yaml
chief:
  capture:
    enabled: true
    target_url: http://localhost:3000
    # tab_id: an-intended-open-tab-id # alternatively bind an existing tab
    interval_ms: 2000
    max_frames: 60
    timeout_ms: 15000
    video: true
```

AV uses `mcpServers.aside` in the source repository's `.mcp.json`, or `aside mcp` when absent. Aside must be installed, expose `repl`, and have browser access. The configured URL/tab is recorded; unrelated tabs and the active tab are not selected implicitly. The target application must be running. A missing URL tab can be opened in Aside.

Screenshots run alongside the mission with stage labels and timestamps, up to `max_frames`. Reaching that limit records partial capture and its last observation time; later mission activity is not presented as recorded. Private artifacts live under `.agent-valley/captures/<mission-id>/`. `ffmpeg` with `libx264` combines frames into an actual MP4. This is periodic screenshot video with recorded durations and no audio. If encoding fails, the report records partial capture and attaches PNG files instead of claiming a video exists. Capture failure does not undo verified work. Retain artifacts for delayed delivery.

Setup's optional integrations step configures reporting, capture and business metric sources/targets. Route pools and prices can be edited in YAML.
