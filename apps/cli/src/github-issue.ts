import type { GithubTrackerConfig } from "@agent-valley/core/config/yaml-loader"

export interface CreatedGithubIssue {
  identifier: string
  title: string
  url: string
}

/** GitHub issue-creation boundary. Routing labels are present on the initial event. */
export async function createGithubIssue(
  config: GithubTrackerConfig,
  input: { title: string; description: string; scope?: string; score?: number | null },
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedGithubIssue> {
  const labels = [config.labels.todo]
  if (input.scope) labels.push(input.scope.startsWith("scope:") ? input.scope : `scope:${input.scope}`)
  if (input.score != null) labels.push(`score:${input.score}`)
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title: input.title, body: input.description, labels }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  if (!response.ok) {
    throw new Error(
      `GitHub issue creation failed (HTTP ${response.status}). Check github.owner/repo in valley.yaml, the token's Issues write permission, and the configured labels in the repository.`,
    )
  }
  const issue = (await response.json()) as { number?: number; title?: string; html_url?: string }
  if (!Number.isSafeInteger(issue.number) || (issue.number ?? 0) < 1 || !issue.title || !issue.html_url) {
    throw new Error(
      "GitHub returned an invalid issue response. Check the repository before retrying to avoid a duplicate.",
    )
  }
  return { identifier: `${config.owner}/${config.repo}#${issue.number}`, title: issue.title, url: issue.html_url }
}
