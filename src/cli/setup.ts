/**
 * Interactive setup wizard — guides users through .env configuration
 * using the Linear API to auto-discover teams and workflow states.
 */

import * as p from "@clack/prompts"
import pc from "picocolors"
import { detectHardware } from "../config/hardware"

export interface LinearTeam {
  id: string
  key: string
  name: string
}

export interface WorkflowState {
  id: string
  name: string
  type: string
}

export async function linearQuery(apiKey: string, query: string): Promise<Record<string, any>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Record<string, any>; errors?: { message: string }[] }
  if (data.errors) throw new Error(data.errors[0].message)

  return data.data!
}

export function findWorkflowState(states: WorkflowState[], names: string[], type: string): WorkflowState | undefined {
  return states.find((st) => names.includes(st.name)) ?? states.find((st) => st.type === type)
}

export interface EnvConfig {
  apiKey: string
  teamKey: string
  teamUuid: string
  webhookSecret: string
  todoStateId: string
  inProgressStateId: string
  doneStateId: string
  cancelledStateId: string
  workspaceRoot: string
  agentType: string
  maxParallel: number
}

export function buildEnvContent(config: EnvConfig): string {
  return [
    "# ── Linear Issue Tracker ──────────────────────────────────",
    `LINEAR_API_KEY=${config.apiKey}`,
    `LINEAR_TEAM_ID=${config.teamKey}`,
    `LINEAR_TEAM_UUID=${config.teamUuid}`,
    `LINEAR_WEBHOOK_SECRET=${config.webhookSecret}`,
    `LINEAR_WORKFLOW_STATE_TODO=${config.todoStateId}`,
    `LINEAR_WORKFLOW_STATE_IN_PROGRESS=${config.inProgressStateId}`,
    `LINEAR_WORKFLOW_STATE_DONE=${config.doneStateId}`,
    `LINEAR_WORKFLOW_STATE_CANCELLED=${config.cancelledStateId}`,
    "",
    "# ── Symphony Orchestrator ─────────────────────────────────",
    `WORKSPACE_ROOT=${config.workspaceRoot}`,
    "LOG_LEVEL=info",
    "",
    "# ── Agent Selection ──────────────────────────────────────",
    `AGENT_TYPE=${config.agentType}`,
    `MAX_PARALLEL=${config.maxParallel}`,
    "SERVER_PORT=9741",
    "",
    "# ── Observability (optional) ─────────────────────────────",
    "LOG_FORMAT=json",
    "",
  ].join("\n")
}

function cancelled(): never {
  p.cancel("취소되었습니다")
  process.exit(0)
}

export async function setup(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup ")))

  // ── Check existing .env ──────────────────────────────────────────────────
  if (await Bun.file(".env").exists()) {
    const overwrite = await p.confirm({ message: ".env 파일이 이미 존재합니다. 덮어쓸까요?" })
    if (p.isCancel(overwrite) || !overwrite) return cancelled()
  }

  // ── Step 1: Linear API Key ───────────────────────────────────────────────
  const apiKey = await p.text({
    message: "Linear API Key",
    placeholder: "lin_api_xxx",
    validate: (v) => {
      if (!v) return "필수 입력입니다"
      if (!v.startsWith("lin_api_")) return "lin_api_ 로 시작해야 합니다. Settings → API 에서 발급하세요"
    },
  })
  if (p.isCancel(apiKey)) return cancelled()

  // ── Step 2: Fetch teams ──────────────────────────────────────────────────
  const s = p.spinner()
  s.start("Linear 팀 조회 중...")

  let teams: LinearTeam[]
  let orgUrlKey: string
  try {
    const [teamsData, viewerData] = await Promise.all([
      linearQuery(apiKey, "{ teams { nodes { id key name } } }"),
      linearQuery(apiKey, "{ viewer { organization { urlKey } } }"),
    ])
    teams = teamsData.teams.nodes as LinearTeam[]
    orgUrlKey = (viewerData.viewer as any).organization.urlKey as string
    s.stop("팀 조회 완료")
  } catch (e) {
    s.stop(pc.red("Linear API 호출 실패"))
    p.log.error(`API 키를 확인하세요: ${(e as Error).message}`)
    return cancelled()
  }

  if (teams.length === 0) {
    p.log.error("팀이 없습니다. Linear에서 팀을 먼저 생성하세요.")
    return cancelled()
  }

  const teamUuid = await p.select({
    message: "팀을 선택하세요",
    options: teams.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` })),
  })
  if (p.isCancel(teamUuid)) return cancelled()

  const selectedTeam = teams.find((t) => t.id === teamUuid)!

  // ── Step 3: Workflow states ──────────────────────────────────────────────
  s.start("워크플로우 상태 조회 중...")

  let states: WorkflowState[]
  try {
    const data = await linearQuery(apiKey, `{ team(id: "${teamUuid}") { states { nodes { id name type } } } }`)
    states = (data.team as any).states.nodes as WorkflowState[]
    s.stop("워크플로우 상태 조회 완료")
  } catch (e) {
    s.stop(pc.red("워크플로우 상태 조회 실패"))
    p.log.error((e as Error).message)
    return cancelled()
  }

  // Auto-map by name, fallback to type
  let todoState = findWorkflowState(states, ["Todo"], "unstarted")
  let inProgressState = findWorkflowState(states, ["In Progress"], "started")
  let doneState = findWorkflowState(states, ["Done"], "completed")
  let cancelledState = findWorkflowState(states, ["Canceled", "Cancelled"], "canceled")

  const fmt = (label: string, st: WorkflowState | undefined) =>
    st ? `${label}: ${pc.green(st.name)} ${pc.dim(st.id)}` : `${label}: ${pc.red("매핑 실패")}`

  p.note(
    [
      fmt("Todo", todoState),
      fmt("In Progress", inProgressState),
      fmt("Done", doneState),
      fmt("Cancelled", cancelledState),
    ].join("\n"),
    "워크플로우 상태 매핑",
  )

  // Manual selection for any missing state
  const stateOptions = states.map((st) => ({ value: st.id, label: `${st.name} (${st.type})` }))

  const selectMissing = async (label: string, current: WorkflowState | undefined) => {
    if (current) return current
    const id = await p.select({ message: `${label} 상태를 선택하세요`, options: stateOptions })
    if (p.isCancel(id)) return cancelled()
    return states.find((st) => st.id === id)!
  }

  todoState = await selectMissing("Todo", todoState)
  inProgressState = await selectMissing("In Progress", inProgressState)
  doneState = await selectMissing("Done", doneState)
  cancelledState = await selectMissing("Cancelled", cancelledState)

  // ── Step 4: Webhook ──────────────────────────────────────────────────────
  const webhookUrl = `https://linear.app/${orgUrlKey}/settings/api`

  p.note(
    [
      `${pc.cyan(webhookUrl)} 에서:`,
      "",
      `1. ${pc.bold("Create webhook")} 클릭`,
      `2. Label: ${pc.dim("Symphony")}`,
      `3. URL: ngrok 터널 URL + ${pc.bold("/webhook")}`,
      `4. Events: ${pc.bold("Issues")} 체크`,
      `5. Team: ${pc.bold(selectedTeam.name)} 선택`,
      `6. 생성 후 Signing secret 복사`,
    ].join("\n"),
    "Webhook 설정 안내",
  )

  const webhookSecret = await p.text({
    message: "Webhook Signing Secret",
    placeholder: "lin_wh_xxx",
    validate: (v) => {
      if (!v) return "필수 입력입니다"
    },
  })
  if (p.isCancel(webhookSecret)) return cancelled()

  // ── Step 5: Workspace root ───────────────────────────────────────────────
  const defaultWorkspace = `${process.env.HOME}/workspaces`

  const workspaceRoot = await p.text({
    message: "에이전트 워크스페이스 경로 (절대경로)",
    placeholder: defaultWorkspace,
    initialValue: defaultWorkspace,
    validate: (v) => {
      if (!v) return "필수 입력입니다"
      if (!v.startsWith("/")) return "절대경로여야 합니다"
    },
  })
  if (p.isCancel(workspaceRoot)) return cancelled()

  // ── Step 6: Agent type ───────────────────────────────────────────────────
  const agentType = await p.select({
    message: "사용할 에이전트",
    options: [
      { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
      { value: "codex", label: "Codex", hint: "OpenAI Codex" },
      { value: "gemini", label: "Gemini", hint: "Google Gemini" },
    ],
  })
  if (p.isCancel(agentType)) return cancelled()

  // ── Step 7: Max parallel agents (hardware-aware) ────────────────────────
  const hw = detectHardware()

  p.note(
    [
      `CPU: ${pc.cyan(String(hw.cpuCores))} cores`,
      `RAM: ${pc.cyan(String(hw.totalMemoryGB))} GB`,
      `추천 동시 에이전트 수: ${pc.green(String(hw.recommended))}`,
    ].join("\n"),
    "하드웨어 감지",
  )

  const useRecommended = await p.confirm({
    message: `동시 에이전트 수를 ${pc.green(String(hw.recommended))}개로 설정할까요?`,
    initialValue: true,
  })
  if (p.isCancel(useRecommended)) return cancelled()

  let maxParallel: number
  if (useRecommended) {
    maxParallel = hw.recommended
  } else {
    const custom = await p.text({
      message: "동시 에이전트 수 (직접 입력)",
      initialValue: String(hw.cpuCores),
      validate: (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) return "1 이상의 정수를 입력하세요"
      },
    })
    if (p.isCancel(custom)) return cancelled()
    maxParallel = Number(custom)
  }

  // ── Write .env ───────────────────────────────────────────────────────────
  const env = buildEnvContent({
    apiKey,
    teamKey: selectedTeam.key,
    teamUuid: teamUuid as string,
    webhookSecret: webhookSecret as string,
    todoStateId: todoState.id,
    inProgressStateId: inProgressState.id,
    doneStateId: doneState.id,
    cancelledStateId: cancelledState.id,
    workspaceRoot: workspaceRoot as string,
    agentType: agentType as string,
    maxParallel,
  })

  await Bun.write(".env", env)

  // Create workspace directory if missing
  const { existsSync, mkdirSync } = await import("node:fs")
  if (!existsSync(workspaceRoot as string)) {
    mkdirSync(workspaceRoot as string, { recursive: true })
    p.log.success(`워크스페이스 디렉토리 생성: ${workspaceRoot}`)
  }

  p.outro(pc.green("설정 완료! `bun av` 로 서버를 시작하세요."))
}
