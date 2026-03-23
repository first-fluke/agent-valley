/**
 * Interactive setup wizard — guides users through .env configuration
 * using the Linear API to auto-discover teams and workflow states.
 *
 * Features:
 *   - Step-based loop with back navigation
 *   - Step progress indicator (Step N/M)
 *   - Webhook pause confirmation
 *   - Final preview with masked API key
 *   - Fast track via invite clipboard detection
 *   - Partial reconfiguration (--edit mode)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { detectHardware } from "@agent-valley/core/config/hardware"
import * as p from "@clack/prompts"
import pc from "picocolors"
import type { InviteData } from "./invite"
import { detectInviteFromClipboard } from "./invite"

// ── Types ────────────────────────────────────────────────────────────────────

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

// ── Step loop constants ──────────────────────────────────────────────────────

const BACK = Symbol("BACK")
const CANCEL = Symbol("CANCEL")
type StepResult = typeof BACK | typeof CANCEL | undefined

// ── Pure utility functions (tested independently) ────────────────────────────

export async function linearQuery(apiKey: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] }
  if (data.errors) throw new Error(data.errors[0]?.message)

  if (!data.data) throw new Error("Linear API returned no data")
  return data.data
}

export function findWorkflowState(states: WorkflowState[], names: string[], type: string): WorkflowState | undefined {
  return states.find((st) => names.includes(st.name)) ?? states.find((st) => st.type === type)
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

export function maskApiKey(key: string): string {
  if (key.length <= 12) return "****"
  return `${key.slice(0, 8)}****${key.slice(-4)}`
}

export function loadExistingEnv(): Partial<EnvConfig> | null {
  try {
    const content = readFileSync(".env", "utf-8")
    const vars: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
    }

    return {
      apiKey: vars.LINEAR_API_KEY,
      teamKey: vars.LINEAR_TEAM_ID,
      teamUuid: vars.LINEAR_TEAM_UUID,
      webhookSecret: vars.LINEAR_WEBHOOK_SECRET,
      todoStateId: vars.LINEAR_WORKFLOW_STATE_TODO,
      inProgressStateId: vars.LINEAR_WORKFLOW_STATE_IN_PROGRESS,
      doneStateId: vars.LINEAR_WORKFLOW_STATE_DONE,
      cancelledStateId: vars.LINEAR_WORKFLOW_STATE_CANCELLED,
      workspaceRoot: vars.WORKSPACE_ROOT,
      agentType: vars.AGENT_TYPE,
      maxParallel: vars.MAX_PARALLEL ? Number(vars.MAX_PARALLEL) : undefined,
    }
  } catch {
    return null
  }
}

// ── Setup context (accumulated across steps) ─────────────────────────────────

interface SetupContext {
  apiKey: string
  teams: LinearTeam[]
  orgUrlKey: string
  teamUuid: string
  selectedTeam: LinearTeam
  states: WorkflowState[]
  todoStateId: string
  inProgressStateId: string
  doneStateId: string
  cancelledStateId: string
  webhookSecret: string
  workspaceRoot: string
  agentType: string
  maxParallel: number
}

// ── Step definitions ─────────────────────────────────────────────────────────

function stepLabel(current: number, total: number, label: string): string {
  return `${pc.dim(`[${current}/${total}]`)} ${label}`
}

async function stepApiKey(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  const apiKey = await p.text({
    message: stepLabel(step, total, "Linear API Key"),
    placeholder: "lin_api_xxx",
    initialValue: ctx.apiKey,
    validate: (v) => {
      if (!v) return "필수 입력입니다"
      if (!v.startsWith("lin_api_")) return "lin_api_ 로 시작해야 합니다. Settings → API 에서 발급하세요"
    },
  })
  if (p.isCancel(apiKey)) return CANCEL

  ctx.apiKey = apiKey
  return
}

async function stepTeam(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  if (!ctx.apiKey) return BACK

  const s = p.spinner()
  s.start("Linear 팀 조회 중...")

  try {
    const [teamsData, viewerData] = await Promise.all([
      linearQuery(ctx.apiKey, "{ teams { nodes { id key name } } }"),
      linearQuery(ctx.apiKey, "{ viewer { organization { urlKey } } }"),
    ])
    ctx.teams = (teamsData as Record<string, Record<string, unknown>>).teams?.nodes as LinearTeam[]
    ctx.orgUrlKey = (viewerData as Record<string, Record<string, Record<string, unknown>>>).viewer?.organization
      ?.urlKey as string
    s.stop("팀 조회 완료")
  } catch (e) {
    s.stop(pc.red("Linear API 호출 실패"))
    p.log.error(`API 키를 확인하세요: ${(e as Error).message}`)
    return BACK
  }

  if (ctx.teams.length === 0) {
    p.log.error("팀이 없습니다. Linear에서 팀을 먼저 생성하세요.")
    return BACK
  }

  const teamUuid = await p.select({
    message: stepLabel(step, total, "팀을 선택하세요"),
    options: ctx.teams.map((t) => ({ value: t.id, label: `${t.name} (${t.key})` })),
  })
  if (p.isCancel(teamUuid)) return CANCEL

  ctx.teamUuid = teamUuid
  ctx.selectedTeam = ctx.teams.find((t) => t.id === teamUuid)
  return
}

async function stepWorkflowStates(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  if (!ctx.apiKey || !ctx.teamUuid) return BACK

  const s = p.spinner()
  s.start("워크플로우 상태 조회 중...")

  try {
    const data = await linearQuery(ctx.apiKey, `{ team(id: "${ctx.teamUuid}") { states { nodes { id name type } } } }`)
    ctx.states = (data as Record<string, Record<string, Record<string, unknown>>>).team?.states
      ?.nodes as WorkflowState[]
    s.stop("워크플로우 상태 조회 완료")
  } catch (e) {
    s.stop(pc.red("워크플로우 상태 조회 실패"))
    p.log.error((e as Error).message)
    return BACK
  }

  const todoState = findWorkflowState(ctx.states, ["Todo"], "unstarted")
  const inProgressState = findWorkflowState(ctx.states, ["In Progress"], "started")
  const doneState = findWorkflowState(ctx.states, ["Done"], "completed")
  const cancelledState = findWorkflowState(ctx.states, ["Canceled", "Cancelled"], "canceled")

  const fmt = (label: string, st: WorkflowState | undefined) =>
    st ? `${label}: ${pc.green(st.name)} ${pc.dim(st.id)}` : `${label}: ${pc.red("매핑 실패")}`

  p.note(
    [
      fmt("Todo", todoState),
      fmt("In Progress", inProgressState),
      fmt("Done", doneState),
      fmt("Cancelled", cancelledState),
    ].join("\n"),
    stepLabel(step, total, "워크플로우 상태 매핑"),
  )

  const stateOptions = ctx.states.map((st) => ({ value: st.id, label: `${st.name} (${st.type})` }))

  const selectMissing = async (label: string, current: WorkflowState | undefined) => {
    if (current) return current
    const id = await p.select({ message: `${label} 상태를 선택하세요`, options: stateOptions })
    if (p.isCancel(id)) return CANCEL
    const found = (ctx.states ?? []).find((st) => st.id === id)
    if (!found) return CANCEL
    return found
  }

  const todo = await selectMissing("Todo", todoState)
  if (todo === CANCEL) return CANCEL
  const inProgress = await selectMissing("In Progress", inProgressState)
  if (inProgress === CANCEL) return CANCEL
  const done = await selectMissing("Done", doneState)
  if (done === CANCEL) return CANCEL
  const cancelled = await selectMissing("Cancelled", cancelledState)
  if (cancelled === CANCEL) return CANCEL

  ctx.todoStateId = (todo as WorkflowState).id
  ctx.inProgressStateId = (inProgress as WorkflowState).id
  ctx.doneStateId = (done as WorkflowState).id
  ctx.cancelledStateId = (cancelled as WorkflowState).id
  return
}

async function stepWebhook(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  if (!ctx.orgUrlKey || !ctx.selectedTeam) return BACK

  const webhookUrl = `https://linear.app/${ctx.orgUrlKey}/settings/api`

  p.note(
    [
      `${pc.cyan(webhookUrl)} 에서:`,
      "",
      `1. ${pc.bold("Create webhook")} 클릭`,
      `2. Label: ${pc.dim("Symphony")}`,
      `3. URL: ngrok 터널 URL + ${pc.bold("/webhook")}`,
      `4. Events: ${pc.bold("Issues")} 체크`,
      `5. Team: ${pc.bold(ctx.selectedTeam.name)} 선택`,
      `6. 생성 후 Signing secret 복사`,
    ].join("\n"),
    stepLabel(step, total, "Webhook 설정 안내"),
  )

  const ready = await p.confirm({ message: "Linear에서 webhook 설정을 완료했나요?" })
  if (p.isCancel(ready)) return CANCEL
  if (!ready) return BACK

  const webhookSecret = await p.text({
    message: "Webhook Signing Secret",
    placeholder: "lin_wh_xxx",
    initialValue: ctx.webhookSecret,
    validate: (v) => {
      if (!v) return "필수 입력입니다"
    },
  })
  if (p.isCancel(webhookSecret)) return CANCEL

  ctx.webhookSecret = webhookSecret
  return
}

async function stepWorkspace(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  const defaultWorkspace = ctx.workspaceRoot ?? `${process.env.HOME}/workspaces`

  const workspaceRoot = await p.text({
    message: stepLabel(step, total, "에이전트 워크스페이스 경로 (절대경로)"),
    placeholder: `${process.env.HOME}/workspaces`,
    initialValue: defaultWorkspace,
    validate: (v) => {
      if (!v) return "필수 입력입니다"
      if (!v.startsWith("/")) return "절대경로여야 합니다"
    },
  })
  if (p.isCancel(workspaceRoot)) return CANCEL

  ctx.workspaceRoot = workspaceRoot
  return
}

async function stepAgentType(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  const agentType = await p.select({
    message: stepLabel(step, total, "사용할 에이전트"),
    options: [
      { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
      { value: "codex", label: "Codex", hint: "OpenAI Codex" },
      { value: "gemini", label: "Gemini", hint: "Google Gemini" },
    ],
  })
  if (p.isCancel(agentType)) return CANCEL

  ctx.agentType = agentType
  return
}

async function stepParallel(ctx: Partial<SetupContext>, step: number, total: number): Promise<StepResult> {
  const hw = detectHardware()

  p.note(
    [
      `CPU: ${pc.cyan(String(hw.cpuCores))} cores`,
      `RAM: ${pc.cyan(String(hw.totalMemoryGB))} GB`,
      `추천 동시 에이전트 수: ${pc.green(String(hw.recommended))}`,
    ].join("\n"),
    stepLabel(step, total, "하드웨어 감지"),
  )

  const useRecommended = await p.confirm({
    message: `동시 에이전트 수를 ${pc.green(String(hw.recommended))}개로 설정할까요?`,
    initialValue: true,
  })
  if (p.isCancel(useRecommended)) return CANCEL

  if (useRecommended) {
    ctx.maxParallel = hw.recommended
  } else {
    const custom = await p.text({
      message: "동시 에이전트 수 (직접 입력)",
      initialValue: String(ctx.maxParallel ?? hw.cpuCores),
      validate: (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) return "1 이상의 정수를 입력하세요"
      },
    })
    if (p.isCancel(custom)) return CANCEL
    ctx.maxParallel = Number(custom)
  }

  return
}

// ── Preview ──────────────────────────────────────────────────────────────────

function renderPreview(ctx: SetupContext): string {
  const lines = [
    `LINEAR_API_KEY          = ${pc.dim(maskApiKey(ctx.apiKey))}`,
    `LINEAR_TEAM_ID          = ${ctx.selectedTeam.key}`,
    `LINEAR_TEAM_UUID        = ${pc.dim(ctx.teamUuid)}`,
    `LINEAR_WEBHOOK_SECRET   = ${pc.dim(maskApiKey(ctx.webhookSecret))}`,
    `WORKFLOW_STATE_TODO     = ${pc.dim(ctx.todoStateId)}`,
    `WORKFLOW_STATE_IN_PROG  = ${pc.dim(ctx.inProgressStateId)}`,
    `WORKFLOW_STATE_DONE     = ${pc.dim(ctx.doneStateId)}`,
    `WORKFLOW_STATE_CANCEL   = ${pc.dim(ctx.cancelledStateId)}`,
    `WORKSPACE_ROOT          = ${ctx.workspaceRoot}`,
    `AGENT_TYPE              = ${pc.cyan(ctx.agentType)}`,
    `MAX_PARALLEL            = ${pc.cyan(String(ctx.maxParallel))}`,
    `SERVER_PORT             = 9741`,
  ]
  return lines.join("\n")
}

// ── Save .env ────────────────────────────────────────────────────────────────

async function saveEnv(ctx: SetupContext): Promise<void> {
  const env = buildEnvContent({
    apiKey: ctx.apiKey,
    teamKey: ctx.selectedTeam.key,
    teamUuid: ctx.teamUuid,
    webhookSecret: ctx.webhookSecret,
    todoStateId: ctx.todoStateId,
    inProgressStateId: ctx.inProgressStateId,
    doneStateId: ctx.doneStateId,
    cancelledStateId: ctx.cancelledStateId,
    workspaceRoot: ctx.workspaceRoot,
    agentType: ctx.agentType,
    maxParallel: ctx.maxParallel,
  })

  writeFileSync(".env", env, "utf-8")

  if (!existsSync(ctx.workspaceRoot)) {
    mkdirSync(ctx.workspaceRoot, { recursive: true })
    p.log.success(`워크스페이스 디렉토리 생성: ${ctx.workspaceRoot}`)
  }
}

// ── Fast track (invite clipboard) ────────────────────────────────────────────

async function fastTrackSetup(invite: InviteData): Promise<void> {
  p.log.info(pc.green("초대 데이터가 감지되었습니다. 팀 설정을 불러옵니다."))

  const ctx: Partial<SetupContext> = {
    teamUuid: invite.teamUuid,
    webhookSecret: invite.webhookSecret,
    todoStateId: invite.todoStateId,
    inProgressStateId: invite.inProgressStateId,
    doneStateId: invite.doneStateId,
    cancelledStateId: invite.cancelledStateId,
    agentType: invite.agentType,
  }

  // We need the team info for display — try fetching, or use invite data
  const teamKey = invite.teamId

  const fastSteps = [
    async (_c: Partial<SetupContext>, step: number, total: number) => stepApiKey(_c, step, total),
    async (_c: Partial<SetupContext>, step: number, total: number) => stepWorkspace(_c, step, total),
    async (_c: Partial<SetupContext>, step: number, total: number) => stepParallel(_c, step, total),
  ]

  const totalSteps = fastSteps.length
  let i = 0
  while (i < fastSteps.length) {
    const result = await fastSteps[i]?.(ctx, i + 1, totalSteps)
    if (result === BACK) {
      i = Math.max(0, i - 1)
      continue
    }
    if (result === CANCEL) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    i++
  }

  // All values guaranteed by step loop above
  if (!ctx.apiKey || !ctx.workspaceRoot || ctx.maxParallel == null) {
    p.log.error("설정 값이 누락되었습니다. 다시 시도하세요.")
    process.exit(1)
  }

  const fullCtx: SetupContext = {
    apiKey: ctx.apiKey,
    teams: [],
    orgUrlKey: "",
    teamUuid: invite.teamUuid,
    selectedTeam: { id: invite.teamUuid, key: teamKey, name: teamKey },
    states: [],
    todoStateId: invite.todoStateId,
    inProgressStateId: invite.inProgressStateId,
    doneStateId: invite.doneStateId,
    cancelledStateId: invite.cancelledStateId,
    webhookSecret: invite.webhookSecret,
    workspaceRoot: ctx.workspaceRoot,
    agentType: invite.agentType,
    maxParallel: ctx.maxParallel,
  }

  // Final preview
  p.note(renderPreview(fullCtx), "설정 확인")
  const confirmed = await p.confirm({ message: "이대로 저장할까요?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  await saveEnv(fullCtx)
  p.outro(pc.green("설정 완료! `bun av` 로 서버를 시작하세요."))
}

// ── Edit mode (partial reconfiguration) ──────────────────────────────────────

const EDITABLE_FIELDS: { value: string; label: string }[] = [
  { value: "apiKey", label: "Linear API Key" },
  { value: "webhookSecret", label: "Webhook Secret" },
  { value: "workspaceRoot", label: "워크스페이스 경로" },
  { value: "agentType", label: "에이전트 타입" },
  { value: "maxParallel", label: "동시 에이전트 수" },
]

export async function setupEdit(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup — Edit ")))

  const existing = loadExistingEnv()
  if (!existing) {
    p.log.error(".env 파일이 없습니다. `bun av setup`을 먼저 실행하세요.")
    process.exit(1)
  }

  const fields = await p.multiselect({
    message: "변경할 항목을 선택하세요",
    options: EDITABLE_FIELDS,
    required: true,
  })
  if (p.isCancel(fields)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const selectedFields = fields as string[]

  if (selectedFields.includes("apiKey")) {
    const apiKey = await p.text({
      message: "Linear API Key",
      placeholder: "lin_api_xxx",
      initialValue: existing.apiKey,
      validate: (v) => {
        if (!v) return "필수 입력입니다"
        if (!v.startsWith("lin_api_")) return "lin_api_ 로 시작해야 합니다"
      },
    })
    if (p.isCancel(apiKey)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    existing.apiKey = apiKey
  }

  if (selectedFields.includes("webhookSecret")) {
    const secret = await p.text({
      message: "Webhook Signing Secret",
      placeholder: "lin_wh_xxx",
      initialValue: existing.webhookSecret,
      validate: (v) => {
        if (!v) return "필수 입력입니다"
      },
    })
    if (p.isCancel(secret)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    existing.webhookSecret = secret
  }

  if (selectedFields.includes("workspaceRoot")) {
    const root = await p.text({
      message: "에이전트 워크스페이스 경로 (절대경로)",
      initialValue: existing.workspaceRoot,
      validate: (v) => {
        if (!v) return "필수 입력입니다"
        if (!v.startsWith("/")) return "절대경로여야 합니다"
      },
    })
    if (p.isCancel(root)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    existing.workspaceRoot = root
  }

  if (selectedFields.includes("agentType")) {
    const agent = await p.select({
      message: "사용할 에이전트",
      options: [
        { value: "claude", label: "Claude", hint: "Anthropic Claude Code" },
        { value: "codex", label: "Codex", hint: "OpenAI Codex" },
        { value: "gemini", label: "Gemini", hint: "Google Gemini" },
      ],
    })
    if (p.isCancel(agent)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    existing.agentType = agent
  }

  if (selectedFields.includes("maxParallel")) {
    const hw = detectHardware()
    p.note(
      [
        `CPU: ${pc.cyan(String(hw.cpuCores))} cores`,
        `RAM: ${pc.cyan(String(hw.totalMemoryGB))} GB`,
        `추천: ${pc.green(String(hw.recommended))}`,
      ].join("\n"),
      "하드웨어 감지",
    )
    const val = await p.text({
      message: "동시 에이전트 수",
      initialValue: String(existing.maxParallel ?? hw.recommended),
      validate: (v) => {
        const n = Number(v)
        if (!Number.isInteger(n) || n < 1) return "1 이상의 정수를 입력하세요"
      },
    })
    if (p.isCancel(val)) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    existing.maxParallel = Number(val)
  }

  // Validate we have all required fields
  const required: (keyof EnvConfig)[] = [
    "apiKey",
    "teamKey",
    "teamUuid",
    "webhookSecret",
    "todoStateId",
    "inProgressStateId",
    "doneStateId",
    "cancelledStateId",
    "workspaceRoot",
    "agentType",
    "maxParallel",
  ]
  for (const key of required) {
    if (!existing[key]) {
      p.log.error(`${key} 값이 없습니다. 전체 설정을 다시 실행하세요: bun av setup`)
      process.exit(1)
    }
  }

  const env = buildEnvContent(existing as EnvConfig)

  p.note(
    env
      .split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        if (l.includes("API_KEY=") || l.includes("SECRET=")) {
          const [key, val] = l.split("=")
          return `${key}=${pc.dim(maskApiKey(val ?? ""))}`
        }
        return l
      })
      .join("\n"),
    "변경 후 설정",
  )

  const confirmed = await p.confirm({ message: "이대로 저장할까요?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  writeFileSync(".env", env, "utf-8")

  if (existing.workspaceRoot && !existsSync(existing.workspaceRoot)) {
    mkdirSync(existing.workspaceRoot, { recursive: true })
    p.log.success(`워크스페이스 디렉토리 생성: ${existing.workspaceRoot}`)
  }

  p.outro(pc.green("설정 변경 완료!"))
}

// ── Full setup ───────────────────────────────────────────────────────────────

export async function setup(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Setup ")))

  // ── Check existing .env ────────────────────────────────────────────────────
  if (existsSync(".env")) {
    const overwrite = await p.confirm({ message: ".env 파일이 이미 존재합니다. 덮어쓸까요?" })
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
  }

  // ── Detect invite in clipboard ─────────────────────────────────────────────
  const invite = await detectInviteFromClipboard()
  if (invite) {
    const useInvite = await p.confirm({ message: "클립보드에서 초대 데이터가 감지되었습니다. 사용할까요?" })
    if (!p.isCancel(useInvite) && useInvite) {
      return fastTrackSetup(invite)
    }
  }

  // ── Full step-based setup ──────────────────────────────────────────────────
  const ctx: Partial<SetupContext> = {}

  type StepFn = (ctx: Partial<SetupContext>, step: number, total: number) => Promise<StepResult>

  const steps: StepFn[] = [
    stepApiKey,
    stepTeam,
    stepWorkflowStates,
    stepWebhook,
    stepWorkspace,
    stepAgentType,
    stepParallel,
  ]

  const totalSteps = steps.length
  let i = 0
  while (i < steps.length) {
    const result = await steps[i]?.(ctx, i + 1, totalSteps)
    if (result === BACK) {
      i = Math.max(0, i - 1)
      continue
    }
    if (result === CANCEL) {
      p.cancel("취소되었습니다")
      process.exit(0)
    }
    i++
  }

  const fullCtx = ctx as SetupContext

  // ── Final preview ──────────────────────────────────────────────────────────
  p.note(renderPreview(fullCtx), "설정 확인")

  const confirmed = await p.confirm({ message: "이대로 저장할까요?" })
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  await saveEnv(fullCtx)
  p.outro(pc.green("설정 완료! `bun av` 로 서버를 시작하세요."))
}
