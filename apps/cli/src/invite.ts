/**
 * Invite — encode/decode team config for clipboard sharing.
 *
 * Flow:
 *   Existing member:  `av invite` → encodes team config → clipboard
 *   New member:       `av setup`  → detects invite in clipboard → fast track
 *
 * Format: av://invite/<base64-json>
 */

import { spawn } from "node:child_process"
import * as p from "@clack/prompts"
import pc from "picocolors"

const INVITE_PREFIX = "av://invite/"

export interface InviteData {
  teamId: string
  teamUuid: string
  webhookSecret: string
  todoStateId: string
  inProgressStateId: string
  doneStateId: string
  cancelledStateId: string
  agentType: string
  serverPort: string
}

const INVITE_KEYS: (keyof InviteData)[] = [
  "teamId",
  "teamUuid",
  "webhookSecret",
  "todoStateId",
  "inProgressStateId",
  "doneStateId",
  "cancelledStateId",
  "agentType",
  "serverPort",
]

const ENV_TO_INVITE: Record<string, keyof InviteData> = {
  LINEAR_TEAM_ID: "teamId",
  LINEAR_TEAM_UUID: "teamUuid",
  LINEAR_WEBHOOK_SECRET: "webhookSecret",
  LINEAR_WORKFLOW_STATE_TODO: "todoStateId",
  LINEAR_WORKFLOW_STATE_IN_PROGRESS: "inProgressStateId",
  LINEAR_WORKFLOW_STATE_DONE: "doneStateId",
  LINEAR_WORKFLOW_STATE_CANCELLED: "cancelledStateId",
  AGENT_TYPE: "agentType",
  SERVER_PORT: "serverPort",
}

export function encodeInvite(data: InviteData): string {
  const json = JSON.stringify(data)
  const b64 = Buffer.from(json).toString("base64url")
  return `${INVITE_PREFIX}${b64}`
}

export function decodeInvite(raw: string): InviteData | null {
  if (!raw.startsWith(INVITE_PREFIX)) return null

  try {
    const b64 = raw.slice(INVITE_PREFIX.length).trim()
    const json = Buffer.from(b64, "base64url").toString("utf-8")
    const data = JSON.parse(json) as Record<string, unknown>

    for (const key of INVITE_KEYS) {
      if (typeof data[key] !== "string") return null
    }

    return data as unknown as InviteData
  } catch {
    return null
  }
}

export async function readClipboard(): Promise<string | null> {
  try {
    const cmd = process.platform === "darwin" ? "pbpaste" : "xclip -selection clipboard -o"
    const parts = cmd.split(" ")
    const proc = spawn(parts[0] as string, parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] })

    const { text, exitCode } = await new Promise<{ text: string; exitCode: number }>((resolve, reject) => {
      const chunks: Buffer[] = []
      proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
      proc.stdout.on("error", reject)
      proc.on("close", (code) => resolve({ text: Buffer.concat(chunks).toString("utf-8"), exitCode: code ?? 1 }))
      proc.on("error", reject)
    })

    return exitCode === 0 ? text.trim() : null
  } catch {
    return null
  }
}

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const cmd = process.platform === "darwin" ? "pbcopy" : "xclip -selection clipboard"
    const parts = cmd.split(" ")
    const proc = spawn(parts[0] as string, parts.slice(1), { stdio: ["pipe", "pipe", "pipe"] })

    proc.stdin.write(text)
    proc.stdin.end()

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.on("close", (code) => resolve(code ?? 1))
      proc.on("error", reject)
    })

    return exitCode === 0
  } catch {
    return false
  }
}

export async function detectInviteFromClipboard(): Promise<InviteData | null> {
  const clip = await readClipboard()
  if (!clip) return null
  return decodeInvite(clip)
}

function loadEnvFile(): Record<string, string> {
  try {
    const content = require("node:fs").readFileSync(".env", "utf-8") as string
    const vars: Record<string, string> = {}
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eqIdx = trimmed.indexOf("=")
      if (eqIdx === -1) continue
      vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1)
    }
    return vars
  } catch {
    return {}
  }
}

export function extractInviteFromEnv(): InviteData | null {
  const vars = loadEnvFile()
  const data: Partial<InviteData> = {}

  for (const [envKey, inviteKey] of Object.entries(ENV_TO_INVITE)) {
    const val = vars[envKey]
    if (!val) return null
    data[inviteKey] = val
  }

  return data as InviteData
}

export async function invite(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Invite ")))

  const data = extractInviteFromEnv()
  if (!data) {
    p.log.error("먼저 `bun av setup`으로 설정을 완료하세요.")
    process.exit(1)
  }

  const encoded = encodeInvite(data)
  const copied = await writeClipboard(encoded)

  if (copied) {
    p.log.success("초대 코드가 클립보드에 복사되었습니다.")
  } else {
    p.log.warning("클립보드 복사에 실패했습니다. 아래 코드를 직접 공유하세요:")
    console.log()
    console.log(encoded)
    console.log()
  }

  p.outro(pc.green("새 멤버에게 전달하세요. `bun av setup` 실행 시 자동 감지됩니다."))
}
