/**
 * Integration test for save.ts — routes global/project writes to the
 * appropriate builder and, critically, never serialises the GitHub PAT.
 *
 * The test sets XDG_CONFIG_HOME and cwd to a tmp dir so we can inspect
 * the exact on-disk bytes.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ResolvedSetupContext } from "../../setup/resolve"
import { saveConfig } from "../../setup/save"

let tmpRoot: string
let originalCwd: string
let originalXdg: string | undefined

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "av-setup-save-"))
  originalCwd = process.cwd()
  originalXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = tmpRoot
  process.chdir(tmpRoot)
})

afterAll(() => {
  process.chdir(originalCwd)
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdg
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe("saveConfig", () => {
  it("writes linear settings.yaml and valley.yaml", async () => {
    const ctx: ResolvedSetupContext = {
      trackerKind: "linear",
      linear: {
        apiKey: "lin_api_12345",
        teams: [],
        orgUrlKey: "acme",
        teamUuid: "uuid-1",
        selectedTeam: { id: "uuid-1", key: "ACR", name: "Acme" },
        states: [],
        todoStateId: "t",
        inProgressStateId: "ip",
        doneStateId: "d",
        cancelledStateId: "c",
        webhookSecret: "lin_wh_sec",
      },
      github: {
        token: "",
        tokenEnv: "",
        owner: "",
        repo: "",
        webhookSecret: "",
        labels: { todo: "", inProgress: "", done: "", cancelled: "" },
      },
      workspaceRoot: join(tmpRoot, "workspaces"),
      agentType: "claude",
      maxParallel: 2,
      tunnel: { provider: "ngrok" },
    }

    await saveConfig(ctx)

    const settings = readFileSync(join(tmpRoot, "agent-valley", "settings.yaml"), "utf-8")
    const valley = readFileSync(join(tmpRoot, "valley.yaml"), "utf-8")

    expect(settings).toContain("api_key: lin_api_12345")
    expect(valley).toContain("kind: linear")
    expect(valley).toContain("team_id: ACR")
  })

  it("writes github valley.yaml with token_env only — never the token", async () => {
    const RAW_TOKEN = "ghp_DO_NOT_PERSIST_ME_0123456789"
    const ctx: ResolvedSetupContext = {
      trackerKind: "github",
      github: {
        token: RAW_TOKEN,
        tokenEnv: "GITHUB_TOKEN",
        owner: "first-fluke",
        repo: "agent-valley",
        webhookSecret: "whsec_abcdefghij0123456789",
        labels: {
          todo: "valley:todo",
          inProgress: "valley:wip",
          done: "valley:done",
          cancelled: "valley:cancelled",
        },
      },
      linear: {
        apiKey: "",
        teams: [],
        orgUrlKey: "",
        teamUuid: "",
        selectedTeam: { id: "", key: "", name: "" },
        states: [],
        todoStateId: "",
        inProgressStateId: "",
        doneStateId: "",
        cancelledStateId: "",
        webhookSecret: "",
      },
      workspaceRoot: join(tmpRoot, "workspaces"),
      agentType: "codex",
      maxParallel: 1,
      tunnel: { provider: "ngrok" },
    }

    await saveConfig(ctx)

    const settings = readFileSync(join(tmpRoot, "agent-valley", "settings.yaml"), "utf-8")
    const valley = readFileSync(join(tmpRoot, "valley.yaml"), "utf-8")

    // settings.yaml must not contain any linear block or any github token
    expect(settings).not.toContain("linear:")
    expect(settings).not.toContain(RAW_TOKEN)

    // valley.yaml must contain token_env reference but not the token itself
    expect(valley).toContain("kind: github")
    expect(valley).toContain("token_env: GITHUB_TOKEN")
    expect(valley).not.toContain(RAW_TOKEN)
    expect(valley).toContain("owner: first-fluke")
    expect(valley).toContain("repo: agent-valley")
    expect(valley).toContain("valley:todo")
  })
})
