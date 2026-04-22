/**
 * GitHub-specific setup steps.
 *
 * Security invariants:
 *   1. The PAT is captured in-memory only. It is never written to
 *      settings.yaml, valley.yaml, or any log line.
 *   2. Only the env var name (`github.token_env`) is persisted. After
 *      save, we instruct the operator to `export <NAME>=<token>`.
 *
 * Flow:
 *   1. PAT prompt + live token verification (GET /user, X-OAuth-Scopes).
 *   2. Token env var name (default GITHUB_TOKEN).
 *   3. Owner + repo + webhook secret (with optional crypto-random default).
 *   4. Label prefix (default "valley" → valley:todo / valley:wip / ...).
 */

import * as p from "@clack/prompts"
import pc from "picocolors"
import { buildGithubLabels, randomWebhookSecret, verifyGithubToken } from "./github-api"
import { BACK, CANCEL, type GithubSetupValues, type SetupContext, type StepResult } from "./types"
import { stepLabel } from "./ui"

function ensureGithub(ctx: SetupContext): Partial<GithubSetupValues> {
  if (!ctx.github) ctx.github = {}
  return ctx.github
}

export async function stepGithubToken(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const gh = ensureGithub(ctx)

  const token = await p.password({
    message: stepLabel(step, total, "GitHub Personal Access Token (scopes: repo or public_repo)"),
    mask: "*",
    validate: (v) => {
      if (!v) return "Required"
      if (v.length < 20) return "Token looks too short. Generate at https://github.com/settings/tokens"
    },
  })
  if (p.isCancel(token)) return CANCEL

  const s = p.spinner()
  s.start("Verifying token against GitHub API...")
  const verification = await verifyGithubToken(token)
  if (!verification.ok) {
    s.stop(pc.red("Token verification failed"))
    p.log.error(verification.error ?? "Unknown verification error")
    // Stay on this step — returning BACK with no previous step would
    // fall off the start; instead just re-run it by returning undefined
    // would move forward. We want the loop to re-ask, so we recurse.
    return stepGithubToken(ctx, step, total)
  }
  s.stop(pc.green(`Token OK${verification.login ? ` (authenticated as ${verification.login})` : ""}`))
  gh.token = token

  const tokenEnv = await p.text({
    message: "Environment variable name to hold the token",
    placeholder: "GITHUB_TOKEN",
    initialValue: gh.tokenEnv ?? "GITHUB_TOKEN",
    validate: (v) => {
      if (!v) return "Required"
      if (!/^[A-Z_][A-Z0-9_]*$/.test(v)) return "Must be UPPER_SNAKE_CASE (letters, digits, underscore)"
    },
  })
  if (p.isCancel(tokenEnv)) return CANCEL
  gh.tokenEnv = tokenEnv
  return
}

export async function stepGithubRepo(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const gh = ensureGithub(ctx)
  if (!gh.token) return BACK

  const owner = await p.text({
    message: stepLabel(step, total, "Repository owner (user or org)"),
    placeholder: "first-fluke",
    initialValue: gh.owner,
    validate: (v) => {
      if (!v) return "Required"
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(v))
        return "Invalid owner. GitHub login: 1–39 chars, alphanumeric or hyphens (no trailing hyphen)."
    },
  })
  if (p.isCancel(owner)) return CANCEL
  gh.owner = owner

  const repo = await p.text({
    message: "Repository name",
    placeholder: "agent-valley",
    initialValue: gh.repo,
    validate: (v) => {
      if (!v) return "Required"
      if (!/^[A-Za-z0-9._-]+$/.test(v)) return "Invalid repo name. Use letters, digits, '.', '_', '-'."
    },
  })
  if (p.isCancel(repo)) return CANCEL
  gh.repo = repo
  return
}

export async function stepGithubWebhookSecret(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const gh = ensureGithub(ctx)
  if (!gh.owner || !gh.repo) return BACK

  const generate = await p.confirm({
    message: stepLabel(step, total, "Generate a random webhook secret?"),
    initialValue: !gh.webhookSecret,
  })
  if (p.isCancel(generate)) return CANCEL

  if (generate) {
    gh.webhookSecret = randomWebhookSecret()
    p.log.success("Generated a 256-bit webhook secret (will be shown in preview).")
  } else {
    const secret = await p.password({
      message: "Webhook secret",
      mask: "*",
      validate: (v) => {
        if (!v) return "Required"
        if (v.length < 16) return "Use at least 16 characters of entropy."
      },
    })
    if (p.isCancel(secret)) return CANCEL
    gh.webhookSecret = secret
  }

  p.note(
    [
      `Create a webhook in ${pc.cyan(`https://github.com/${gh.owner}/${gh.repo}/settings/hooks/new`)}:`,
      "",
      `1. Payload URL: your ngrok/HTTPS URL + ${pc.bold("/api/webhook")}`,
      `2. Content type: ${pc.bold("application/json")}`,
      `3. Secret: ${pc.bold("paste the value from the preview below")}`,
      `4. Events: ${pc.bold("Issues, Issue comment, Pull requests")}`,
    ].join("\n"),
    "GitHub Webhook Setup Guide",
  )

  const ready = await p.confirm({ message: "Have you saved the secret where you will create the webhook?" })
  if (p.isCancel(ready)) return CANCEL
  if (!ready) return BACK
  return
}

export async function stepGithubLabels(ctx: SetupContext, step: number, total: number): Promise<StepResult> {
  const gh = ensureGithub(ctx)
  if (!gh.webhookSecret) return BACK

  const prefix = await p.text({
    message: stepLabel(step, total, "Label prefix"),
    placeholder: "valley",
    initialValue: "valley",
    validate: (v) => {
      if (!v) return "Required"
      if (!/^[A-Za-z0-9_-]+$/.test(v)) return "Invalid prefix. Use letters, digits, '-', '_'."
    },
  })
  if (p.isCancel(prefix)) return CANCEL

  gh.labels = buildGithubLabels(prefix)

  p.note(
    [
      `todo         = ${pc.cyan(gh.labels.todo)}`,
      `in_progress  = ${pc.cyan(gh.labels.inProgress)}`,
      `done         = ${pc.cyan(gh.labels.done)}`,
      `cancelled    = ${pc.cyan(gh.labels.cancelled)}`,
    ].join("\n"),
    "Labels",
  )
  return
}
