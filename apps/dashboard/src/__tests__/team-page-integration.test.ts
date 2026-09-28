import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"

const page = readFileSync(resolve(import.meta.dirname, "../app/page.tsx"), "utf8")
const hook = readFileSync(resolve(import.meta.dirname, "../features/team/hooks/use-team-ledger.ts"), "utf8")

describe("team dashboard wiring", () => {
  test("selects team state only when connected and keeps local state as fallback", () => {
    expect(page).toContain("useTeamLedger()")
    expect(page).toContain('team.mode === "team" && team.status === "connected" ? team.teamState : localTeamState')
  })

  test("shows relay errors in an accessible alert", () => {
    expect(page).toContain("team.error")
    expect(page).toContain('role="alert"')
  })

  test("browser fetches only the same-origin relay and does not receive Supabase credentials", () => {
    expect(hook).toContain('fetch("/api/team/ledger"')
    expect(hook).not.toContain("supabaseAnonKey")
    expect(hook).not.toContain("accessToken")
    expect(hook).not.toContain("NEXT_PUBLIC_")
  })
})
