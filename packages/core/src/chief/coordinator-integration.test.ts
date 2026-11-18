import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { coordinate } from "./coordinator"
import { fixture, passed, rejected } from "./goal-supervision.fixture"
import { INTEGRATION_CHECK_RULE } from "./prompts"
import {
  combinedIntegrationResult,
  integrationCheckCommand,
  integrationCheckEnabled,
  integrationEvidenceFor,
  operatorIntegrationResult,
  reusableEvidence,
} from "./runtime-integration-check"
import { executeCommandChecks, executeGoalVerification, safeVerificationCommand } from "./verification"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function codeFixture() {
  const value = fixture()
  const worker = value.mission.personas.find((persona) => persona.id === "worker")
  if (!worker) throw new Error("Expected the fixture worker")
  worker.skills = ["oma-backend"]
  return value
}

describe("integration check between task delivery and review", () => {
  it("runs the contract commands before review and gives the reviewer the observed failure", async () => {
    const { mission, ports, runAgent } = codeFixture()
    mission.maxRepairs = 1
    const check = vi.fn(async () => ({ ok: false, output: "cargo test --workspace\nFAIL: legacy_fixture ... FAILED" }))
    ports.integrationCheck = check
    const original = runAgent.getMockImplementation()
    let reviews = 0
    runAgent.mockImplementation(async (...args) => {
      if (args[3] === "review") {
        expect(args[1]).toContain(INTEGRATION_CHECK_RULE)
        if (reviews++ === 0) {
          expect(args[1]).toContain("legacy_fixture ... FAILED")
          check.mockResolvedValue({ ok: true, output: "cargo test --workspace\nPASS: all tests" })
          return rejected
        }
        expect(args[1]).toContain("PASS: all tests")
        return passed
      }
      return (await original?.(...args)) ?? ""
    })
    await coordinate(mission, ports)
    // One check per delivery: the first attempt and its repair, never one per review retry.
    expect(check).toHaveBeenCalledTimes(2)
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.integrationCheck?.ok).toBe(true)
    expect(mission.history.filter((event) => event.stage === "integration-check")).toHaveLength(2)
  })

  it("skips tasks without a code skill and survives a check that cannot run", async () => {
    const documentation = fixture()
    const unused = vi.fn(async () => ({ ok: true, output: "unused" }))
    documentation.ports.integrationCheck = unused
    await coordinate(documentation.mission, documentation.ports)
    expect(unused).not.toHaveBeenCalled()

    const { mission, ports, runAgent } = codeFixture()
    ports.integrationCheck = vi.fn(async () => {
      throw new Error("cargo is not installed")
    })
    await coordinate(mission, ports)
    expect(mission.status).toBe("completed")
    expect(mission.tasks[0]?.integrationCheck).toBeUndefined()
    expect(runAgent.mock.calls.find((call) => call[3] === "review")?.[1]).not.toContain(INTEGRATION_CHECK_RULE)
    expect(mission.history.find((event) => event.stage === "integration-check")?.message).toContain("skipped")
  })

  it("is enabled only by AV_INTEGRATION_CHECK=1", () => {
    expect(integrationCheckEnabled({})).toBe(false)
    expect(integrationCheckEnabled({ AV_INTEGRATION_CHECK: "0" })).toBe(false)
    expect(integrationCheckEnabled({ AV_INTEGRATION_CHECK: "1" })).toBe(true)
  })

  it("lets the operator supply the project's own gate command, which also enables the check", () => {
    expect(integrationCheckCommand({})).toBeUndefined()
    expect(integrationCheckCommand({ AV_INTEGRATION_CHECK_COMMAND: "  " })).toBeUndefined()
    const env = { AV_INTEGRATION_CHECK_COMMAND: " cargo test --workspace && ./scripts/harness/validate.sh " }
    expect(integrationCheckCommand(env)).toBe("cargo test --workspace && ./scripts/harness/validate.sh")
    expect(integrationCheckEnabled(env)).toBe(true)
    expect(operatorIntegrationResult("make gate", { ok: true, output: "noise" })).toEqual({
      ok: true,
      output: "make gate\nPASS: the operator's integration command exited zero.",
    })
    const failed = operatorIntegrationResult("make gate", {
      ok: false,
      output: `${"x".repeat(20_000)}harness: layer violation`,
    })
    expect(failed.ok).toBe(false)
    expect(failed.output).toContain("exited nonzero")
    expect(failed.output.endsWith("harness: layer violation")).toBe(true)
    expect(failed.output.length).toBeLessThanOrEqual(8_000)
    expect(operatorIntegrationResult("make gate", { ok: false, output: "", timedOut: true }).output).toContain(
      "timed out",
    )
    // The failing step of a long chained gate is above the retained tail; the result names the complete log.
    const logged = operatorIntegrationResult(
      "make gate",
      { ok: false, output: "last passing step" },
      "/work/.agent-valley/integration-checks/2026-11-18T06-00-00-000Z.log",
    )
    expect(logged.output).toContain(
      "Complete output of this check: /work/.agent-valley/integration-checks/2026-11-18T06-00-00-000Z.log",
    )
    expect(logged.output.endsWith("last passing step")).toBe(true)
  })
})

describe("command-only contract checks", () => {
  it("runs each distinct command once, ignores file and JSON checks and reports failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "av-integration-check-"))
    roots.push(root)
    await writeFile(join(root, "a.test.js"), "")
    const command = { kind: "command", program: "node", args: ["--test", "a.test.js"] }
    const contract = {
      version: 1,
      criteria: [
        { criterion: "Tests pass", checks: [command, { kind: "file", path: "missing-evidence.json", minBytes: 1 }] },
        { criterion: "Tests still pass", checks: [command] },
      ],
    }
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
    const options = { successCriteria: ["Tests pass", "Tests still pass"], executeCommand }
    expect(await executeCommandChecks(contract, root, options)).toMatchObject({ ok: true })
    expect(executeCommand).toHaveBeenCalledOnce()
    executeCommand.mockResolvedValueOnce({ exitCode: 1, stdout: "test legacy ... FAILED", stderr: "" })
    const failed = await executeCommandChecks(contract, root, options)
    expect(failed?.ok).toBe(false)
    expect(failed?.output).toContain("node --test a.test.js")
    expect(failed?.output).toContain("legacy ... FAILED")
    const filesOnly = { version: 1, criteria: [{ criterion: "Tests pass", checks: [contract.criteria[0]?.checks[1]] }] }
    expect(await executeCommandChecks(filesOnly, root, { successCriteria: ["Tests pass"] })).toBeUndefined()
  })
})

describe("verification reuses integration evidence from the identical workspace", () => {
  const command = { kind: "command", program: "node", args: ["--test", "a.test.js"] }
  const contract = { version: 1, criteria: [{ criterion: "Tests pass", checks: [command] }] }
  const successCriteria = ["Tests pass"]

  async function observed() {
    const root = await mkdtemp(join(tmpdir(), "av-integration-evidence-"))
    roots.push(root)
    await writeFile(join(root, "a.test.js"), "// first")
    const executeCommand = vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "" }))
    const check = await executeCommandChecks(contract, root, { successCriteria, executeCommand })
    if (!check) throw new Error("Expected a command check result")
    return { root, executeCommand, check }
  }

  it("does not run a command again while its evidence and inputs are unchanged", async () => {
    const { root, executeCommand, check } = await observed()
    const evidence = reusableEvidence(check, "same", "same", new Date("2026-01-01T00:00:00Z"))
    expect(evidence).toMatchObject({ fingerprint: "same", checkedAt: "2026-01-01T00:00:00.000Z" })
    const result = await executeGoalVerification(contract, root, {
      successCriteria,
      executeCommand,
      reuse: evidence?.checks,
    })
    expect(executeCommand).toHaveBeenCalledOnce()
    expect(result.ok).toBe(true)
    expect(result.evidence[0]?.checks[0]).toMatchObject({
      passed: true,
      exitCode: 0,
      outputSha256: check.evidence[0]?.outputSha256,
    })
    expect(result.evidence[0]?.checks[0]?.summary).toContain("reused")
  })

  it("runs the command again when a bound input changed or the earlier run failed", async () => {
    const { root, executeCommand, check } = await observed()
    await writeFile(join(root, "a.test.js"), "// second")
    await executeGoalVerification(contract, root, { successCriteria, executeCommand, reuse: check.evidence })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    const failed = check.evidence.map((entry) => ({ ...entry, passed: false, exitCode: 1 }))
    await executeGoalVerification(contract, root, { successCriteria, executeCommand, reuse: failed })
    expect(executeCommand).toHaveBeenCalledTimes(3)
  })

  it("keeps evidence only for a fully passing check that left the workspace unchanged", async () => {
    const { check } = await observed()
    expect(reusableEvidence(check, "before", "after")).toBeUndefined()
    expect(reusableEvidence({ ...check, ok: false }, "same", "same")).toBeUndefined()
    const partial = [...check.evidence, { ...check.evidence[0], passed: false, exitCode: 1 }] as typeof check.evidence
    expect(reusableEvidence({ ok: true, evidence: partial }, "same", "same")).toBeUndefined()
    expect(reusableEvidence({ ok: true, evidence: [] }, "same", "same")).toBeUndefined()
  })

  it("offers evidence only while the workspace fingerprint still matches", async () => {
    const { mission } = codeFixture()
    const { check } = await observed()
    expect(await integrationEvidenceFor(mission, async () => "same")).toBeUndefined()
    mission.integrationEvidence = reusableEvidence(check, "same", "same")
    expect(await integrationEvidenceFor(mission, async () => "same")).toEqual(check.evidence)
    expect(await integrationEvidenceFor(mission, async () => "changed")).toBeUndefined()
    expect(
      await integrationEvidenceFor(mission, async () => {
        throw new Error("no git metadata")
      }),
    ).toBeUndefined()
  })

  it("leads a combined result with the failing part and keeps the end of a long operator output", () => {
    const contractPart = { ok: true, output: "cargo test --workspace\nPASS" }
    const operator = { ok: false, output: `make gate\nFAIL${"x".repeat(9_000)}harness: layer violation` }
    const combined = combinedIntegrationResult(contractPart, operator)
    expect(combined.ok).toBe(false)
    expect(combined.output.startsWith("make gate")).toBe(true)
    expect(combined.output).toContain("harness: layer violation")
    expect(combined.output.endsWith("cargo test --workspace\nPASS")).toBe(true)
    expect(combined.output.length).toBeLessThanOrEqual(8_000)
    expect(combinedIntegrationResult(contractPart, { ok: true, output: "make gate\nPASS" })).toEqual({
      ok: true,
      output: "cargo test --workspace\nPASS\n\nmake gate\nPASS",
    })
  })

  it("accepts a workspace test run that reports every failing binary", () => {
    expect(safeVerificationCommand("cargo", ["test", "--workspace", "--no-fail-fast"])).toBe(true)
    expect(safeVerificationCommand("cargo", ["test", "--workspace", "--no-run"])).toBe(false)
  })
})
