import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  BusinessExperiment,
  BusinessMetricSample,
  OrganizationMemory,
} from "@agent-valley/core/chief/organization"
import {
  dispatchMissionReport,
  listReportDeliveries,
  type ReportDeliveryPolicy,
  type ReportDeliveryReceipt,
} from "@agent-valley/core/chief/report-delivery"
import { mission } from "@agent-valley/core/chief/reports.fixture"
import { loadGlobalConfig, loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { Command } from "commander"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { organizationRepository, registerOrganizationCommands } from "../chief-organization"

vi.mock("@agent-valley/core/config/yaml-loader", () => ({ loadGlobalConfig: vi.fn(), loadProjectConfig: vi.fn() }))

let root: string
let repository: string
let reporting: ReportDeliveryPolicy | undefined
const hook = "https://hooks.example.test/synthetic-command-secret"

function config(): void {
  vi.mocked(loadGlobalConfig).mockReturnValue(null)
  vi.mocked(loadProjectConfig).mockReturnValue({
    workspace: { root: repository },
    chief: { reporting },
  } as NonNullable<ReturnType<typeof loadProjectConfig>>)
}
async function run(args: string[]): Promise<void> {
  const program = new Command().exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} })
  registerOrganizationCommands(program)
  await program.parseAsync(args, { from: "user" })
}
function output<T>(): T {
  const text = vi.mocked(console.log).mock.lastCall?.[0]
  if (typeof text !== "string") throw new Error("Expected JSON command output")
  return JSON.parse(text) as T
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "av-cli-organization-"))
  repository = join(root, "source")
  await mkdir(repository)
  reporting = undefined
  config()
  vi.spyOn(process, "cwd").mockReturnValue(root)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.stubEnv("CLI_REPORT_URL", hook)
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 200 })),
  )
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe("public organization commands", () => {
  it("records and lists human-approved memory in the configured source repository", async () => {
    await run([
      "memory",
      "add",
      "Use the existing PostgreSQL database",
      "--kind",
      "stack-standard",
      "--source",
      "Operator decision",
      "--tags",
      " database, reuse, ",
    ])
    const record = output<OrganizationMemory>()
    expect(record).toMatchObject({
      approval: "human-approved",
      kind: "stack-standard",
      tags: ["database", "reuse"],
      source: "Operator decision",
    })
    await run(["memory", "list"])
    expect(output<OrganizationMemory[]>()).toEqual([record])
    const memories = join(repository, ".agent-valley/organization/memories")
    expect(await readFile(join(memories, (await readdir(memories))[0] ?? "missing-record"), "utf8")).toContain(
      "PostgreSQL",
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("honors explicit workspace scopes and rejects relative repository paths", async () => {
    const other = join(root, "other-repository")
    await mkdir(other)
    await run(["memory", "add", "Other repo decision", "--workspace", other])
    await run(["memory", "list"])
    expect(output()).toEqual([])
    await run(["memory", "list", "--workspace", other])
    expect(output<OrganizationMemory[]>()[0]?.content).toBe("Other repo decision")
    expect(organizationRepository(root, other)).toBe(other)
    await expect(run(["memory", "list", "--workspace", "relative-path"])).rejects.toThrow("absolute source repository")
  })

  it("records observed numbers and imports source-bound metrics without contacting analytics", async () => {
    await run([
      "metrics",
      "record",
      "conversion",
      "4.2",
      "--unit",
      "percent",
      "--source",
      "Analytics export",
      "--at",
      "2026-01-01T00:00:00Z",
      "--experiment",
      "checkout",
    ])
    const first = output<BusinessMetricSample>()
    expect(first).toMatchObject({
      value: 4.2,
      unit: "percent",
      source: "Analytics export",
      provenance: "operator-recorded",
      experimentId: "checkout",
    })
    const file = join(root, "observations.json")
    await writeFile(
      file,
      JSON.stringify([
        {
          name: "conversion",
          value: 5.1,
          unit: "percent",
          source: "Follow-up export",
          timestamp: "2026-01-02T00:00:00Z",
        },
      ]),
    )
    await run(["metrics", "import", file])
    const imported = output<BusinessMetricSample[]>()
    await run(["metrics", "list"])
    expect(output<BusinessMetricSample[]>()).toEqual([first, ...imported])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("rejects nonfinite values, missing provenance options and invalid or oversized input", async () => {
    for (const value of ["", "NaN", "Infinity"])
      await expect(
        run([
          "metrics",
          "record",
          "conversion",
          value,
          "--unit",
          "percent",
          "--source",
          "export",
          "--at",
          "2026-01-01T00:00:00Z",
        ]),
      ).rejects.toThrow("finite number")
    await expect(
      run(["metrics", "record", "conversion", "4.2", "--unit", "percent", "--at", "2026-01-01T00:00:00Z"]),
    ).rejects.toThrow("source")
    const malformed = join(root, "invalid.json")
    await writeFile(malformed, "not JSON")
    await expect(run(["metrics", "import", malformed])).rejects.toThrow()
    const large = join(root, "large.json")
    await writeFile(large, " ".repeat(2_000_001))
    await expect(run(["metrics", "import", large])).rejects.toThrow("2 MB")
    await expect(run(["metrics", "import", repository])).rejects.toThrow("regular JSON input")
    await run(["metrics", "list"])
    expect(output()).toEqual([])
  })

  it("records and lists experiments linked to actual before and after sample ids", async () => {
    const ids: string[] = []
    for (const [value, at] of [
      ["4.2", "2026-01-01T00:00:00Z"],
      ["5.1", "2026-01-02T00:00:00Z"],
    ] as const) {
      await run([
        "metrics",
        "record",
        "conversion",
        value,
        "--unit",
        "percent",
        "--source",
        "Analytics export",
        "--at",
        at,
      ])
      ids.push(output<BusinessMetricSample>().id)
    }
    const file = join(root, "experiment.json")
    await writeFile(
      file,
      JSON.stringify({
        id: "checkout",
        name: "Checkout redesign",
        hypothesis: "Shorter checkout improves conversion",
        targets: [{ name: "conversion", unit: "percent", direction: "increase", target: 5 }],
        beforeSampleIds: ids.slice(0, 1),
        afterSampleIds: ids.slice(1),
        timestamp: "2026-01-03T00:00:00Z",
      }),
    )
    await run(["metrics", "experiment", "--file", file])
    const recorded = output<BusinessExperiment>()
    expect(recorded.comparisons[0]).toMatchObject({ status: "improved", targetMet: true })
    await run(["metrics", "experiment"])
    expect(output<BusinessExperiment[]>()).toEqual([recorded])
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe("public durable report commands", () => {
  it("lists and retries native report bytes using current destination config and the source repository", async () => {
    const artifactRoot = join(repository, ".agent-valley/captures")
    await mkdir(artifactRoot, { recursive: true })
    const markdown = "# Saved operator report\nConfirmed work; no Actor rerun."
    const path = join(artifactRoot, "report.md")
    await writeFile(path, markdown)
    reporting = { destinations: [{ id: "operator", channel: "slack", url_env: "CLI_REPORT_URL" }] }
    config()
    await dispatchMissionReport(mission(), markdown, "/old-report.md", reporting, join(repository, ".agent-valley"), {
      attachments: [
        {
          path,
          name: "report.md",
          mimeType: "text/markdown",
          sizeBytes: Buffer.byteLength(markdown),
          sha256: createHash("sha256").update(markdown).digest("hex"),
        },
      ],
    })
    await run(["reports", "list"])
    const pending = output<ReportDeliveryReceipt[]>()
    expect(pending[0]).toMatchObject({ status: "pending", nextPart: 0 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
    reporting = { destinations: [{ id: "operator", channel: "webhook", url_env: "CLI_REPORT_URL" }] }
    config()
    await run(["reports", "retry"])
    const delivered = output<ReportDeliveryReceipt[]>()
    expect(delivered[0]).toMatchObject({ id: pending[0]?.id, channel: "webhook", status: "delivered" })
    const fetch = vi.mocked(globalThis.fetch)
    const form = fetch.mock.calls.find(([, options]) => options?.body instanceof FormData)?.[1]?.body as FormData
    expect(await (form.get("files") as Blob).text()).toBe(markdown)
    expect(await listReportDeliveries(join(root, ".agent-valley"))).toEqual([])
    fetch.mockClear()
    await run(["reports", "retry"])
    expect(output()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("reads an explicit workspace and explains missing reporting configuration before retry", async () => {
    const other = join(root, "other-repo")
    await mkdir(other)
    await run(["reports", "list", "--workspace", other])
    expect(output()).toEqual([])
    await expect(run(["reports", "retry", "--workspace", other])).rejects.toThrow(
      "chief.reporting.destinations in av.yaml",
    )
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})
