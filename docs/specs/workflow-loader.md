# Workflow Loader

> Responsibility: Parses the `WORKFLOW.md` file and returns typed configuration and a prompt template.
> SRP: This component only parses. Configuration validation is handled by `config-layer.md`, and execution by `orchestrator.md`.

---

## WORKFLOW.md Structure

```
---
[YAML front matter]
---
[Prompt body (Markdown)]
```

The two sections are separated by `---` delimiters.

### YAML Front Matter Example

```yaml
---
tracker:
  url: https://api.linear.app/graphql
  apiKey: $LINEAR_API_KEY
  teamId: $LINEAR_TEAM_ID
  workflow_states:
    todo: $LINEAR_WORKFLOW_STATE_TODO
    in_progress: $LINEAR_WORKFLOW_STATE_IN_PROGRESS
    done: $LINEAR_WORKFLOW_STATE_DONE
    cancelled: $LINEAR_WORKFLOW_STATE_CANCELLED

workspace:
  rootPath: $WORKSPACE_ROOT
  keyPattern: "[A-Za-z0-9._-]"

agent:
  type: codex
  timeout: 1800

concurrency:
  maxParallel: 3

server:
  port: 9741
---
```

### Prompt Body Example

```markdown
You are a software engineer working on issue {{issue.identifier}}: {{issue.title}}.

## Context

- Issue: {{issue.url}}
- Workspace: {{workspace_path}}
- Attempt: {{attempt.id}} (retry count: {{retry_count}})

## Description

{{issue.description}}

## Task

Complete the issue as described above.
```

---

## Parsing Responsibility

### Input

- `WORKFLOW.md` file path (absolute path)

### Output

```
WorkflowConfig {
  raw      : object       // Raw object parsed from YAML front matter
  prompt   : string       // Prompt body (original text before template variable substitution)
  filePath : string       // Absolute path to the original file
  loadedAt : ISO8601 string
}
```

### Parsing Steps

1. Read the file
2. Find the first `---` line -> YAML start
3. Find the second `---` line -> YAML end, prompt body start
4. Parse YAML -> `raw` object
5. Remaining text -> `prompt` string
6. Substitute `$VAR` patterns with environment variables (delegated to Config Layer)

---

## Template Variables

Variables available in the prompt body. They are substituted at agent execution time.

| Variable                | Substitution Value                | Source                                   |
| ----------------------- | --------------------------------- | ---------------------------------------- |
| `{{issue}}`             | Full Issue JSON                   | `domain-models.md` Issue                 |
| `{{issue.identifier}}`  | Issue identifier (e.g., `ACR-42`) | Issue.identifier                         |
| `{{issue.title}}`       | Issue title                       | Issue.title                              |
| `{{issue.description}}` | Issue body                        | Issue.description — **untrusted source** |
| `{{issue.url}}`         | Linear issue URL                  | Issue.url                                |
| `{{attempt}}`           | Full RunAttempt JSON              | `domain-models.md` RunAttempt            |
| `{{attempt.id}}`        | RunAttempt ID                     | RunAttempt.id                            |
| `{{workspace_path}}`    | Workspace absolute path           | Workspace.path                           |
| `{{retry_count}}`       | Cumulative retry count            | RetryEntry.attemptCount (0 if absent)    |

**Security note:** `{{issue.description}}` is an external input susceptible to prompt injection.
Escaping or sandboxing must be applied before insertion. Details: `docs/harness/SAFETY.md`.

---

## Version Control

- `WORKFLOW.md` is managed via git.
- Change detection method: file mtime or git HEAD hash comparison.
- **Rolling restart required on change detection**: Send a reload signal to the Orchestrator.
- The Orchestrator completes any currently running RunAttempts before applying the new configuration.

---

## Error Handling

On parse failure, refuse to start the Orchestrator. Include remediation instructions in the error message.

| Error Condition            | Error Message Format                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| File not found             | `WORKFLOW.md not found at {path}. Create it from the template: cp WORKFLOW.md.example WORKFLOW.md` |
| Missing `---` delimiters   | `WORKFLOW.md missing YAML front matter. Add --- delimiters at the top of the file.`                |
| YAML parse failure         | `WORKFLOW.md YAML parse error at line {n}: {detail}. Fix the YAML syntax and restart.`             |
| Missing required key       | `WORKFLOW.md missing required key: {key}. Add it under the {section} section.`                     |
| Unset environment variable | `WORKFLOW.md references unset env var: {VAR}. Set it in .env or export it before starting.`        |

On error, the process terminates immediately (exit code 1).
