import { SUPPORTED_OMA_VERSION } from "@agent-valley/core/oma/receipt-adapter"
import { describe, expect, test } from "vitest"
import type { DoctorDeps } from "../doctor-checks"
import { checkOma } from "../doctor-oma-checks"

const table = JSON.stringify({
  workflows: { debug: { persistent: false, keywords: { en: ["debug"] } } },
  skills: {},
  informationalPatterns: {},
  excludedWorkflows: [],
})

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cwd: "/project",
    home: "/home/user",
    platform: "darwin",
    env: {},
    existsSync: () => true,
    readFileSync: () => table,
    resolveBinary: () => "/usr/local/bin/oma",
    isSandboxExecAvailable: async () => true,
    isBwrapAvailable: async () => true,
    resolveGlobalConfigPath: () => "",
    loadGlobalConfig: () => null,
    loadProjectConfig: () => null,
    getOmaVersion: () => SUPPORTED_OMA_VERSION,
    ...overrides,
  }
}

describe("checkOma", () => {
  test("requires code verification even when OMA is off", () => {
    expect(checkOma({}, deps())).toMatchObject([
      { id: "task.code", status: "fail", critical: true },
      { id: "oma.mode", status: "warn", critical: false },
    ])
  })

  test("accepts an explicit analysis report template without OMA", () => {
    expect(checkOma({ task: { kind: "analysis", report_path: "reports/{{attempt.id}}.md" } }, deps())[0]).toMatchObject(
      { id: "task.analysis", status: "pass" },
    )
  })

  test("passes compatible strict CLI, verification, trigger table and workflow files", () => {
    const results = checkOma({ oma: { mode: "strict" }, verify: { command: "npm test" } }, deps())
    expect(results.map((result) => result.status)).toEqual(["pass", "pass", "pass", "pass", "pass"])
  })

  test("gives actionable strict-mode failures for missing tooling, checks and workflow files", () => {
    const results = checkOma(
      { oma: { mode: "strict" } },
      deps({
        resolveBinary: () => null,
        existsSync: () => false,
      }),
    )
    expect(results.filter((result) => result.status === "fail").map((result) => result.id)).toEqual([
      "task.code",
      "oma.cli",
      "oma.verify",
      "oma.workflows",
    ])
    expect(results.every((result) => result.status === "pass" || Boolean(result.fix))).toBe(true)
  })

  test("rejects an incompatible trigger schema and CLI version", () => {
    const results = checkOma(
      { oma: { mode: "strict" }, verify: { command: "npm test" } },
      deps({
        getOmaVersion: () => "16.0.0",
        readFileSync: () => JSON.stringify({ ...JSON.parse(table), schemaVersion: 2 }),
      }),
    )
    expect(results.find((result) => result.id === "oma.cli")?.status).toBe("fail")
    expect(results.find((result) => result.id === "oma.triggers")?.status).toBe("fail")
  })

  test("rejects the older CLI contract with an explicit upgrade instruction", () => {
    const results = checkOma(
      { oma: { mode: "strict" }, verify: { command: "npm test" } },
      deps({ getOmaVersion: () => "15.0.4" }),
    )
    expect(results.find((result) => result.id === "oma.cli")).toMatchObject({
      status: "fail",
      critical: true,
      fix: expect.stringContaining(SUPPORTED_OMA_VERSION),
    })
  })
})
