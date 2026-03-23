/**
 * CLI login command — authenticates with Supabase via OAuth or email.
 * Stores credentials in ~/.agent-valley/credentials.json (0600).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import * as p from "@clack/prompts"
import pc from "picocolors"

const CONFIG_DIR = join(homedir(), ".agent-valley")
const CREDENTIALS_FILE = join(CONFIG_DIR, "credentials.json")

export interface Credentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  supabaseUrl: string
  userId: string
  email: string
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  }
}

export function saveCredentials(creds: Credentials): void {
  ensureConfigDir()
  writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_FILE)) return null
  try {
    const raw = readFileSync(CREDENTIALS_FILE, "utf-8")
    return JSON.parse(raw) as Credentials
  } catch {
    return null
  }
}

export function clearCredentials(): void {
  if (existsSync(CREDENTIALS_FILE)) {
    writeFileSync(CREDENTIALS_FILE, "", { mode: 0o600 })
  }
}

async function loginWithEmail(supabaseUrl: string, supabaseAnonKey: string): Promise<Credentials> {
  const email = await p.text({
    message: "이메일",
    placeholder: "you@company.com",
    validate: (v) => (!v?.includes("@") ? "유효한 이메일을 입력하세요" : undefined),
  })
  if (p.isCancel(email)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const password = await p.password({
    message: "비밀번호",
    validate: (v) => ((v?.length ?? 0) < 6 ? "비밀번호는 6자 이상이어야 합니다" : undefined),
  })
  if (p.isCancel(password)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const msg = (body.error_description ?? body.msg ?? "로그인 실패") as string
    throw new Error(msg)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    user: { id: string; email: string }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    supabaseUrl,
    userId: data.user.id,
    email: data.user.email,
  }
}

async function signupWithEmail(supabaseUrl: string, supabaseAnonKey: string): Promise<Credentials> {
  const email = await p.text({
    message: "이메일",
    placeholder: "you@company.com",
    validate: (v) => (!v?.includes("@") ? "유효한 이메일을 입력하세요" : undefined),
  })
  if (p.isCancel(email)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const password = await p.password({
    message: "비밀번호 (6자 이상)",
    validate: (v) => ((v?.length ?? 0) < 6 ? "비밀번호는 6자 이상이어야 합니다" : undefined),
  })
  if (p.isCancel(password)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const res = await fetch(`${supabaseUrl}/auth/v1/signup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ email, password }),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
    const msg = (body.error_description ?? body.msg ?? "가입 실패") as string
    throw new Error(msg)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    user: { id: string; email: string }
  }

  if (!data.access_token) {
    p.log.info("이메일 확인 링크가 발송되었습니다. 확인 후 다시 로그인하세요.")
    process.exit(0)
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    supabaseUrl,
    userId: data.user.id,
    email: data.user.email,
  }
}

export async function login(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" Agent Valley Login ")))

  const existing = loadCredentials()
  if (existing && existing.expiresAt > Date.now()) {
    p.log.info(`이미 로그인되어 있습니다: ${existing.email}`)
    const relogin = await p.confirm({ message: "다시 로그인하시겠어요?" })
    if (p.isCancel(relogin) || !relogin) {
      p.outro("기존 로그인 유지")
      return
    }
  }

  const supabaseUrl = await p.text({
    message: "Supabase URL",
    placeholder: "https://xxx.supabase.co",
    validate: (v) => (!v?.startsWith("https://") ? "https://로 시작해야 합니다" : undefined),
  })
  if (p.isCancel(supabaseUrl)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const supabaseAnonKey = await p.text({
    message: "Supabase Anon Key",
    placeholder: "eyJhbGciOiJIUzI1NiIs...",
    validate: (v) => ((v?.length ?? 0) < 20 ? "유효한 키를 입력하세요" : undefined),
  })
  if (p.isCancel(supabaseAnonKey)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const action = await p.select({
    message: "로그인 방식",
    options: [
      { value: "login", label: "기존 계정으로 로그인" },
      { value: "signup", label: "새 계정 만들기" },
    ],
  })
  if (p.isCancel(action)) {
    p.cancel("취소되었습니다")
    process.exit(0)
  }

  const spinner = p.spinner()
  spinner.start("인증 중...")

  try {
    const creds =
      action === "signup"
        ? await signupWithEmail(supabaseUrl as string, supabaseAnonKey as string)
        : await loginWithEmail(supabaseUrl as string, supabaseAnonKey as string)

    saveCredentials(creds)
    spinner.stop("인증 완료")

    p.log.success(`${creds.email} 로 로그인되었습니다`)
    p.log.info(`자격증명 저장: ${CREDENTIALS_FILE}`)
    p.outro(pc.green("로그인 완료!"))
  } catch (err) {
    spinner.stop("인증 실패")
    p.log.error(String(err instanceof Error ? err.message : err))
    p.outro(pc.red("로그인에 실패했습니다. 다시 시도하세요."))
    process.exit(1)
  }
}

export async function logout(): Promise<void> {
  clearCredentials()
  p.log.success("로그아웃 완료")
}
