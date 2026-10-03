import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { stepChief } from "../setup/chief-step"
import { renderPreview } from "../setup/preview"
import { resolveContext } from "../setup/resolve"
import { BACK, CANCEL, type SetupContext } from "../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn() },
}))
const existing = () =>
  chiefConfigSchema.parse({
    routing: { candidates: [{ actor_type: "codex", model: "chosen" }] },
    review_vendor: "require",
    memory: false,
    metric_targets: [{ name: "conversion", direction: "increase", target: 0.2 }],
    reporting: {
      destinations: [{ id: "custom-slack", channel: "slack", url_env: "OLD_SLACK_URL" }],
      events: ["failed"],
      timeout_ms: 20_000,
      max_attempts: 5,
    },
    capture: { enabled: true, target_url: "https://example.test/old", max_frames: 20, video: false },
  })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(p.select).mockResolvedValue("keep")
  vi.mocked(p.multiselect).mockResolvedValue([])
  vi.mocked(p.confirm).mockResolvedValue(true)
  vi.mocked(p.text).mockImplementation(
    async (args) => args.initialValue ?? (args.message.includes("optional; blank") ? "" : "https://example.test/app"),
  )
})

describe("optional Chief integrations setup", () => {
  it("defaults to disabled integrations without marking untouched settings for replacement", async () => {
    const ctx: SetupContext = {}
    expect(await stepChief(ctx, 4, 5)).toBeUndefined()
    expect(ctx).toEqual({})
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: "keep",
        options: expect.arrayContaining([expect.objectContaining({ value: "keep", label: "Set up later" })]),
      }),
    )
    expect(p.text).not.toHaveBeenCalled()
    expect(p.multiselect).not.toHaveBeenCalled()
  })

  it("keeps all existing integrations and advanced settings without reprompting", async () => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    await stepChief(ctx, 1, 1)
    expect(ctx).toEqual({ chief })
    expect(p.select).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.arrayContaining([expect.objectContaining({ value: "keep", label: "Keep current settings" })]),
      }),
    )
  })

  it("disables only reporting/capture when explicitly requested", async () => {
    const ctx: SetupContext = { chief: existing() }
    vi.mocked(p.select).mockResolvedValue("disable")
    await stepChief(ctx, 1, 1)
    expect(ctx.chiefChanged).toBe(true)
    expect(ctx.chief?.reporting?.destinations).toEqual([])
    expect(ctx.chief?.capture?.enabled).toBe(false)
    expect(ctx.chief?.routing).toEqual(existing().routing)
    expect(ctx.chief?.metric_targets).toEqual(existing().metric_targets)
  })

  it("configures all seven channels using environment names and API file-upload requirements", async () => {
    const ctx: SetupContext = {}
    const channels = ["slack", "discord", "telegram", "teams", "google-chat", "mattermost", "webhook"]
    vi.mocked(p.select).mockResolvedValueOnce("configure").mockResolvedValueOnce("url")
    vi.mocked(p.multiselect).mockResolvedValue(channels)
    await stepChief(ctx, 4, 5)
    const reporting = ctx.chief?.reporting
    expect(reporting?.destinations.map((entry) => entry.channel)).toEqual(channels)
    expect(reporting?.destinations.find((entry) => entry.channel === "slack")).toEqual({
      id: "slack",
      channel: "slack",
      token_env: "SLACK_BOT_TOKEN",
      channel_id_env: "SLACK_CHANNEL_ID",
    })
    expect(reporting?.destinations.find((entry) => entry.channel === "teams")).toEqual({
      id: "teams",
      channel: "teams",
      token_env: "TEAMS_BOT_TOKEN",
      team_id_env: "TEAMS_TEAM_ID",
      channel_id_env: "TEAMS_CHANNEL_ID",
      drive_id_env: "TEAMS_DRIVE_ID",
    })
    expect(reporting?.events).toEqual(["completed", "failed"])
    expect(ctx.chief?.capture).toMatchObject({ enabled: true, target_url: "https://example.test/app", video: true })
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining("Aside"), "Capture runtime requirements")
    expect(p.confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("ffmpeg") }))
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("unverified"))
    expect(chiefConfigSchema.safeParse(ctx.chief).success).toBe(true)
  })

  it("supports webhook text reports without capture and retains delivery timing/events", async () => {
    const ctx: SetupContext = { chief: existing() }
    vi.mocked(p.select).mockResolvedValueOnce("configure").mockResolvedValueOnce("off").mockResolvedValueOnce("webhook")
    vi.mocked(p.multiselect).mockResolvedValue(["slack"])
    await stepChief(ctx, 1, 1)
    expect(ctx.chief?.reporting).toMatchObject({
      destinations: [{ id: "custom-slack", channel: "slack", url_env: "OLD_SLACK_URL" }],
      events: ["failed"],
      timeout_ms: 20_000,
      max_attempts: 5,
    })
    expect(ctx.chief?.capture?.enabled).toBe(false)
    expect(ctx.chief?.routing).toEqual(existing().routing)
  })

  it("allows capture only and switches the URL binding to the intended Aside tab", async () => {
    const ctx: SetupContext = { chief: existing() }
    vi.mocked(p.select).mockResolvedValueOnce("configure").mockResolvedValueOnce("tab")
    vi.mocked(p.text).mockResolvedValue("tab-42")
    vi.mocked(p.confirm).mockResolvedValue(false)
    await stepChief(ctx, 1, 1)
    expect(ctx.chief?.reporting?.destinations).toEqual([])
    expect(ctx.chief?.capture).toMatchObject({ enabled: true, tab_id: "tab-42", video: false, max_frames: 20 })
    expect(ctx.chief?.capture?.target_url).toBeUndefined()
  })

  it.each(["back", Symbol("cancel")])("leaves settings intact on initial navigation: %s", async (choice) => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    vi.mocked(p.select).mockResolvedValue(choice)
    expect(await stepChief(ctx, 1, 1)).toBe(choice === "back" ? BACK : CANCEL)
    expect(ctx).toEqual({ chief })
  })

  it.each(["channels", "capture", "target", "video", "connection", "env", "optional-token"])(
    "does not apply partial changes on cancellation at %s",
    async (stage) => {
      const chief = existing()
      const ctx: SetupContext = { chief }
      const cancel: Exclude<Awaited<ReturnType<typeof p.text>>, string> = Symbol("cancel") as Exclude<
        Awaited<ReturnType<typeof p.text>>,
        string
      >
      vi.mocked(p.select)
        .mockResolvedValueOnce("configure")
        .mockResolvedValueOnce(stage === "connection" || stage === "env" || stage === "optional-token" ? "off" : "url")
        .mockResolvedValue("api")
      vi.mocked(p.multiselect).mockResolvedValue([stage === "optional-token" ? "webhook" : "slack"])
      if (stage === "channels") vi.mocked(p.multiselect).mockResolvedValue(cancel)
      if (stage === "capture")
        vi.mocked(p.select).mockReset().mockResolvedValueOnce("configure").mockResolvedValueOnce(cancel)
      if (stage === "target") vi.mocked(p.text).mockResolvedValue(cancel)
      if (stage === "video") vi.mocked(p.confirm).mockResolvedValue(cancel)
      if (stage === "connection")
        vi.mocked(p.select)
          .mockReset()
          .mockResolvedValueOnce("configure")
          .mockResolvedValueOnce("off")
          .mockResolvedValueOnce(cancel)
      if (stage === "env") vi.mocked(p.text).mockResolvedValue(cancel)
      if (stage === "optional-token")
        vi.mocked(p.text).mockResolvedValueOnce("CUSTOM_WEBHOOK_URL").mockResolvedValueOnce(cancel)
      expect(await stepChief(ctx, 1, 1)).toBe(CANCEL)
      expect(ctx).toEqual({ chief })
    },
  )

  it.each(["capture", "target", "connection", "env"])("returns Back without partial changes at %s", async (stage) => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    vi.mocked(p.select)
      .mockResolvedValueOnce("configure")
      .mockResolvedValueOnce(stage === "capture" ? "back" : stage === "target" ? "url" : "off")
      .mockResolvedValueOnce(stage === "connection" ? "back" : "api")
    vi.mocked(p.multiselect).mockResolvedValue(["slack"])
    vi.mocked(p.text).mockResolvedValue(":back")
    expect(await stepChief(ctx, 1, 1)).toBe(BACK)
    expect(ctx).toEqual({ chief })
  })

  it("rejects actual secrets/URLs as environment names and credential-bearing capture URLs", async () => {
    vi.mocked(p.select).mockResolvedValueOnce("configure").mockResolvedValueOnce("url")
    vi.mocked(p.multiselect).mockResolvedValue(["discord"])
    await stepChief({}, 1, 1)
    const targetValidator = vi.mocked(p.text).mock.calls[0]?.[0].validate
    if (typeof targetValidator !== "function") throw new Error("Capture validator missing")
    expect(targetValidator("https://secret:token@example.test/")).toContain("without embedded credentials")
    expect(targetValidator("file:///etc/passwd")).toContain("HTTP(S)")
    expect(targetValidator("https://example.test/app")).toBeUndefined()
    const envValidator = vi.mocked(p.text).mock.calls[1]?.[0].validate
    if (typeof envValidator !== "function") throw new Error("Environment validator missing")
    expect(envValidator("https://secret.example/hook")).toContain("never its secret")
    expect(envValidator("secret-token-value")).toContain("never its secret")
    expect(envValidator("DISCORD_WEBHOOK_URL")).toBeUndefined()
  })

  it("previews only environment names and marks unverified capture dependencies", () => {
    const result = resolveContext({
      trackerKind: "none",
      workspaceRoot: "/repo",
      agentType: "codex",
      verifyCommand: "test",
      chief: existing(),
      chiefChanged: true,
    })
    if (!result.ok) throw new Error(result.error)
    const preview = renderPreview(result.ctx)
    expect(preview).toContain("slack")
    expect(preview).toContain("OLD_SLACK_URL (environment name only)")
    expect(preview).toContain("runtime unverified")
    expect(result.ctx.chiefChanged).toBe(true)
    expect(result.ctx.chief).toEqual(existing())
  })
})
