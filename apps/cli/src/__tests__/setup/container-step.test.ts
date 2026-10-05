import { chiefConfigSchema } from "@agent-valley/core/config/chief-schema"
import * as p from "@clack/prompts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { stepChief } from "../../setup/chief-step"
import { stepContainers } from "../../setup/container-step"
import { BACK, CANCEL, type SetupContext } from "../../setup/types"

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  note: vi.fn(),
  isCancel: (value: unknown) => typeof value === "symbol",
  log: { info: vi.fn() },
}))

let action: string
let kind: string
let answers: Map<string, string>
const existing = () =>
  chiefConfigSchema.parse({
    memory: false,
    review_vendor: "require",
    reporting: { destinations: [{ id: "report", channel: "webhook", url_env: "REPORT_URL" }] },
    container_observation: {
      poll_interval_sec: 60,
      timeout_ms: 3_000,
      max_output_bytes: 16_384,
      log_tail: 12,
      log_since_sec: 120,
      cpu_percent_threshold: 90,
      memory_percent_threshold: 75,
      targets: [
        { id: "api", kind: "docker", container: "app-api", context: "orbstack" },
        { id: "worker", kind: "docker", container: "app-worker" },
      ],
    },
  })

beforeEach(() => {
  vi.resetAllMocks()
  action = "add"
  kind = "docker"
  answers = new Map([
    ["Target ID", "frontend"],
    ["Docker context (optional; OrbStack usually uses orbstack)", "orbstack"],
    ["Kubernetes context (optional)", "production"],
    ["Kubernetes namespace", "app"],
    ["Exact Kubernetes Pod name", "web-abc"],
    ["Exact container name inside the Pod", "web"],
    ["Exact Docker container name or ID", "app-web"],
  ])
  vi.mocked(p.select).mockImplementation(async (args) => {
    if (args.message.includes("Optional reports")) return "containers"
    if (args.message === "Container observation targets") return action
    if (args.message === "Select the target to replace") return "api"
    return kind
  })
  vi.mocked(p.text).mockImplementation(
    async (args) => answers.get(args.message.replace(" (:back goes back)", "")) ?? args.initialValue ?? "",
  )
})

describe("container observation setup", () => {
  it("connects the optional Chief action to an explicit Docker/OrbStack target with bounded defaults", async () => {
    const ctx: SetupContext = {}
    await stepChief(ctx, 4, 5)
    expect(ctx.chiefChanged).toBe(true)
    expect(ctx.chief?.container_observation).toMatchObject({
      enabled: true,
      poll_interval_sec: 30,
      timeout_ms: 10_000,
      max_output_bytes: 65_536,
      log_tail: 50,
      log_since_sec: 300,
      targets: [{ id: "frontend", kind: "docker", container: "app-web", context: "orbstack" }],
    })
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("selected targets must be healthy before a mission can complete"),
      "Container observation requirements",
    )
    expect(p.note).toHaveBeenCalledWith(
      expect.stringContaining("does not connect, authenticate, start a daemon or run a model"),
      expect.any(String),
    )
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("remain unverified"))
  })

  it("requires a named Kubernetes context/namespace/Pod/container without selectors or broad scanning", async () => {
    kind = "kubernetes"
    const ctx: SetupContext = {}
    await stepContainers(ctx)
    expect(ctx.chief?.container_observation?.targets).toEqual([
      { id: "frontend", kind: "kubernetes", context: "production", namespace: "app", pod: "web-abc", container: "web" },
    ])
  })

  it("adds one unique target while preserving other targets, resource thresholds and Chief policies", async () => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    await stepContainers(ctx)
    expect(ctx.chief?.container_observation).toEqual({
      ...chief.container_observation,
      targets: [
        ...(chief.container_observation?.targets ?? []),
        { id: "frontend", kind: "docker", container: "app-web", context: "orbstack" },
      ],
    })
    expect(ctx.chief?.memory).toBe(false)
    expect(ctx.chief?.review_vendor).toBe("require")
    expect(ctx.chief?.reporting).toEqual(chief.reporting)
    expect(chief.container_observation?.targets).toHaveLength(2)
  })

  it("replaces only the explicitly selected target and removes fields from the former runtime", async () => {
    action = "replace"
    kind = "kubernetes"
    const ctx: SetupContext = { chief: existing() }
    answers.set("Kubernetes context (optional)", "")
    await stepContainers(ctx)
    expect(p.select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select the target to replace" }))
    expect(ctx.chief?.container_observation?.targets).toEqual([
      { id: "frontend", kind: "kubernetes", namespace: "app", pod: "web-abc", container: "web" },
      { id: "worker", kind: "docker", container: "app-worker" },
    ])
    expect(ctx.chief?.container_observation?.poll_interval_sec).toBe(60)
  })

  it("disables an inherited policy explicitly while retaining its targets for later editing", async () => {
    action = "disable"
    const chief = existing()
    const ctx: SetupContext = { chief }
    await stepContainers(ctx)
    expect(ctx.chief?.container_observation).toEqual({ ...chief.container_observation, enabled: false })
    expect(ctx.chief?.reporting).toEqual(chief.reporting)
    expect(ctx.chiefChanged).toBe(true)
    expect(p.text).not.toHaveBeenCalled()
  })

  it("keeps a disabled policy without making settings active or marking them changed", async () => {
    action = "keep"
    const chief = existing()
    if (!chief.container_observation) throw new Error("Missing fixture policy")
    chief.container_observation.enabled = false
    const ctx: SetupContext = { chief }
    await stepContainers(ctx)
    expect(ctx).toEqual({ chief })
    expect(ctx.chief?.container_observation?.enabled).toBe(false)
    expect(p.text).not.toHaveBeenCalled()
  })

  it("re-enables retained targets without replacing them or changing advanced settings", async () => {
    action = "enable"
    const chief = existing()
    if (!chief.container_observation) throw new Error("Missing fixture policy")
    chief.container_observation.enabled = false
    const ctx: SetupContext = { chief }
    await stepContainers(ctx)
    expect(ctx.chief?.container_observation).toEqual({ ...chief.container_observation, enabled: true })
    expect(ctx.chiefChanged).toBe(true)
    expect(p.text).not.toHaveBeenCalled()
    expect(p.note).toHaveBeenCalledWith(expect.stringContaining("must be healthy"), expect.any(String))
  })

  it("uses saved target and collection settings when editing the selected target", async () => {
    action = "replace"
    answers.clear()
    const chief = existing()
    const ctx: SetupContext = { chief }
    await stepContainers(ctx)
    expect(ctx.chief).toEqual(chief)
    expect(p.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Target ID"), initialValue: "api" }),
    )
    expect(p.text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Docker context"), initialValue: "orbstack" }),
    )
    expect(ctx.chiefChanged).toBe(true)
  })

  it.each(["action", "runtime", "context", "logs"])(
    "does not apply partial changes when cancelled at %s",
    async (stage) => {
      const chief = existing()
      const ctx: SetupContext = { chief }
      const cancel = Symbol("cancel") as Exclude<Awaited<ReturnType<typeof p.text>>, string>
      vi.mocked(p.select).mockImplementation(async (args) => {
        if (args.message === "Container observation targets") return stage === "action" ? cancel : "add"
        return stage === "runtime" ? cancel : "docker"
      })
      vi.mocked(p.text).mockImplementation(async (args): Promise<Awaited<ReturnType<typeof p.text>>> => {
        if (
          (stage === "context" && args.message.startsWith("Docker context")) ||
          (stage === "logs" && args.message.startsWith("Log lookback"))
        )
          return cancel as Awaited<ReturnType<typeof p.text>>
        return answers.get(args.message.replace(" (:back goes back)", "")) ?? args.initialValue ?? ""
      })
      expect(await stepContainers(ctx)).toBe(CANCEL)
      expect(ctx).toEqual({ chief })
    },
  )

  it.each(["action", "replace", "runtime", "poll"])("returns Back without partial changes at %s", async (stage) => {
    const chief = existing()
    const ctx: SetupContext = { chief }
    vi.mocked(p.select).mockImplementation(async (args) => {
      if (args.message === "Container observation targets")
        return stage === "action" ? "back" : stage === "replace" ? "replace" : "add"
      if (args.message === "Select the target to replace") return ":back"
      return stage === "runtime" ? "back" : "docker"
    })
    if (stage === "poll") answers.set("Container polling interval in seconds", ":back")
    expect(await stepContainers(ctx)).toBe(BACK)
    expect(ctx).toEqual({ chief })
  })

  it("validates unique IDs, flag-free targets/contexts and bounded polling/log inputs", async () => {
    await stepContainers({ chief: existing() })
    const validator = (prefix: string) => {
      const validate = vi.mocked(p.text).mock.calls.find(([args]) => args.message.startsWith(prefix))?.[0].validate
      if (typeof validate !== "function") throw new Error(`Missing validator: ${prefix}`)
      return validate
    }
    expect(validator("Target ID")("api")).toContain("already exists")
    expect(validator("Target ID")("new-target")).toBeUndefined()
    expect(validator("Exact Docker")("--all")).toContain("explicit")
    expect(validator("Docker context")("https://secret:token@example.test")).toContain("credentials")
    expect(validator("Docker context")("orbstack")).toBeUndefined()
    expect(validator("Container polling")("0")).toContain("bounded whole number")
    expect(validator("Container polling")("3601")).toContain("bounded whole number")
    expect(validator("Maximum log")("201")).toContain("bounded whole number")
    expect(validator("Log lookback")("86401")).toContain("bounded whole number")
  })

  it("offers only explicit replacement at the target limit", async () => {
    const chief = existing()
    if (!chief.container_observation) throw new Error("Missing fixture policy")
    chief.container_observation.targets = Array.from({ length: 20 }, (_, index) => ({
      id: `target-${index}`,
      kind: "docker" as const,
      container: `app-${index}`,
    }))
    action = "keep"
    await stepContainers({ chief })
    const options = vi.mocked(p.select).mock.calls[0]?.[0].options
    expect(options?.some((option) => option.value === "add")).toBe(false)
    expect(options?.some((option) => option.value === "replace")).toBe(true)
  })
})
