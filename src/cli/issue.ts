/**
 * Issue creation command — creates a Linear issue via GraphQL API.
 * Uses Claude CLI to expand rough input into a structured issue.
 */

import * as p from "@clack/prompts"
import pc from "picocolors"

const CREATE_ISSUE_MUTATION = `
mutation CreateIssue($teamId: String!, $title: String!, $description: String!, $stateId: String!) {
  issueCreate(input: { teamId: $teamId, title: $title, description: $description, stateId: $stateId }) {
    success
    issue {
      id
      identifier
      title
      url
    }
  }
}
`

const EXPAND_PROMPT = `You are a technical issue writer. Given a rough idea, produce a structured Linear issue.

Output format (no markdown fences, just raw text):
TITLE: type(scope): concise title
DESCRIPTION:
## Goal
One sentence stating the objective.

## Requirements
- Bullet list of concrete requirements (3-5 items)
- Include technical details: endpoints, data structures, error handling
- Be specific but concise

## Notes
- Implementation hints or constraints if relevant

Rules:
- Title must use conventional commit format: feat|fix|refactor|chore(scope): description
- Description must be actionable — an AI agent will implement this directly
- Infer reasonable technical details from the rough input
- Write in the same language as the input
- Do NOT wrap in markdown code blocks`

export interface IssueInput {
  title: string
  description: string
}

export function parseIssueInput(raw: string): IssueInput {
  const newlineIdx = raw.indexOf("\n")
  if (newlineIdx !== -1) {
    return {
      title: raw.slice(0, newlineIdx).trim(),
      description: raw.slice(newlineIdx + 1).trim(),
    }
  }
  return { title: raw.trim(), description: "" }
}

export function parseExpandedIssue(output: string): IssueInput {
  const titleMatch = output.match(/^TITLE:\s*(.+)$/m)
  const descMatch = output.match(/^DESCRIPTION:\s*\n([\s\S]+)$/m)

  return {
    title: titleMatch?.[1]?.trim() ?? output.slice(0, 80).trim(),
    description: descMatch?.[1]?.trim() ?? "",
  }
}

async function expandWithClaude(rawInput: string): Promise<IssueInput> {
  const proc = Bun.spawn(
    ["claude", "--print", "--no-session-persistence", "-p", `${EXPAND_PROMPT}\n\nInput: ${rawInput}`],
    { stdout: "pipe", stderr: "pipe" },
  )

  const output = await new Response(proc.stdout).text()
  await proc.exited

  if (proc.exitCode !== 0) {
    throw new Error("Claude CLI failed. Falling back to raw input.")
  }

  return parseExpandedIssue(output)
}

export async function createIssue(input: string | undefined, options?: { yes?: boolean; raw?: boolean }): Promise<void> {
  const autoConfirm = options?.yes ?? false
  const noExpand = options?.raw ?? false
  const apiKey = process.env.LINEAR_API_KEY
  const teamUuid = process.env.LINEAR_TEAM_UUID
  const todoStateId = process.env.LINEAR_WORKFLOW_STATE_TODO

  if (!apiKey || !teamUuid || !todoStateId) {
    console.log(pc.red("설정이 필요합니다. `bun agent-valley setup` 을 먼저 실행하세요."))
    process.exit(1)
  }

  let title: string
  let description: string

  if (!input) {
    // Interactive mode
    p.intro(pc.bgMagenta(pc.black(" New Issue ")))

    const t = await p.text({
      message: "무엇을 만들까요?",
      placeholder: "로그인 기능 추가",
      validate: (v) => {
        if (!v) return "필수 입력입니다"
      },
    })
    if (p.isCancel(t)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    input = t
  }

  const s = p.spinner()

  if (noExpand) {
    const parsed = parseIssueInput(input)
    title = parsed.title || input
    description = parsed.description
  } else {
    // Expand with Claude
    s.start("이슈 확장 중...")

    try {
      const expanded = await expandWithClaude(input)
      title = expanded.title
      description = expanded.description
      s.stop("이슈 확장 완료")
    } catch {
      // Fallback: use raw input as-is
      s.stop(pc.yellow("Claude CLI 사용 불가 — 원본 입력 사용"))
      const parsed = parseIssueInput(input)
      title = parsed.title || input
      description = parsed.description
    }
  }

  // Show preview and confirm
  p.note(
    [`${pc.bold(title)}`, "", description || pc.dim("(설명 없음)")].join("\n"),
    "이슈 미리보기",
  )

  if (!autoConfirm) {
    const confirmed = await p.confirm({ message: "이대로 생성할까요?" })
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
  }

  // Create in Linear
  s.start("Linear 이슈 생성 중...")

  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: CREATE_ISSUE_MUTATION,
        variables: { teamId: teamUuid, title, description, stateId: todoStateId },
      }),
    })

    if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`)

    const result = (await res.json()) as {
      data?: { issueCreate?: { success: boolean; issue?: { identifier: string; title: string; url: string } } }
      errors?: { message: string }[]
    }

    if (result.errors) throw new Error(result.errors[0].message)
    if (!result.data?.issueCreate?.success) throw new Error("Issue creation failed")

    const issue = result.data.issueCreate.issue!
    s.stop(pc.green(`이슈 생성 완료: ${issue.identifier}`))

    p.note(
      [
        `${pc.bold(issue.identifier)}: ${issue.title}`,
        "",
        pc.dim(issue.url),
        "",
        `상태: ${pc.green("Todo")} → 서버가 실행 중이면 자동으로 에이전트가 시작됩니다`,
      ].join("\n"),
      "Created",
    )
  } catch (e) {
    s.stop(pc.red("이슈 생성 실패"))
    console.log(pc.red((e as Error).message))
    process.exit(1)
  }
}
