import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeGoalVerification, verificationReruns } from "./verification"
import { readVerificationFile, verificationBudget, verificationRoot } from "./verification-files"

const roots: string[] = []
async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "av-verification-rerun-"))
  roots.push(root)
  await writeFile(join(root, "harness.test.js"), "test fixture")
  return root
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const contract = {
  version: 1,
  criteria: [
    {
      criterion: "Harness passes",
      checks: [{ kind: "command", program: "node", args: ["--test", "harness.test.js"], timeoutMs: 120_000 }],
    },
  ],
}
const successCriteria = ["Harness passes"]
const failed = {
  exitCode: 101,
  stdout: "test swift::process::retains_parent ... FAILED\ntest result: FAILED. 9 passed; 1 failed",
  stderr: "error: test failed, to rerun pass `-p arc-daemon --test traffic_native_tools`",
}
const passed = { exitCode: 0, stdout: "test result: ok. 10 passed; 0 failed", stderr: "" }
/** One failing libtest binary, as `cargo test --no-fail-fast` prints it. */
function cargoRun(verdicts: Record<string, "ok" | "FAILED">) {
  const lines = Object.entries(verdicts).map(([name, verdict]) => `test ${name} ... ${verdict}`)
  const failures = Object.values(verdicts).filter((verdict) => verdict === "FAILED").length
  return {
    exitCode: 101,
    stdout: `running ${lines.length} tests\n${lines.join("\n")}\n\ntest result: FAILED. ${lines.length - failures} passed; ${failures} failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n`,
    stderr: "error: 1 target failed:\n    `-p arc-daemon --test traffic_native_tools`\n",
  }
}

describe("verification of a nondeterministic command", () => {
  it("passes a command that fails once and passes again on the unchanged workspace, and names the failure", async () => {
    const executeCommand = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(passed)
    const result = await executeGoalVerification(contract, await workspace(), {
      successCriteria,
      executeCommand,
      commandReruns: 1,
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    const check = result.evidence[0]?.checks[0]
    expect(check?.exitCode).toBe(0)
    expect(check?.summary).toContain("NONDETERMINISTIC")
    expect(check?.summary).toContain("swift::process::retains_parent ... FAILED")
  })

  it("fails a command that fails in every run", async () => {
    const executeCommand = vi.fn().mockResolvedValue(failed)
    const result = await executeGoalVerification(contract, await workspace(), {
      successCriteria,
      executeCommand,
      commandReruns: 1,
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(false)
    expect(result.output).toContain("in each of 2 runs")
  })

  it("passes a command whose runs each fail in a test that passed in the other run, and names those tests", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce(cargoRun({ cmake_pairs: "FAILED", go_pairs: "ok", attribution: "ok" }))
      .mockResolvedValueOnce(cargoRun({ cmake_pairs: "ok", go_pairs: "FAILED", attribution: "FAILED" }))
    const result = await executeGoalVerification(contract, await workspace(), {
      successCriteria,
      executeCommand,
      commandReruns: 1,
    })
    expect(executeCommand).toHaveBeenCalledTimes(2)
    expect(result.ok).toBe(true)
    const check = result.evidence[0]?.checks[0]
    expect(check?.exitCode).toBe(101)
    expect(check?.nondeterministic).toEqual(["attribution", "cmake_pairs", "go_pairs"])
    expect(check?.summary).toContain("NONDETERMINISTIC: attribution, cmake_pairs, go_pairs")
  })

  it("fails a command when one test fails in every run although the other failures differ", async () => {
    const executeCommand = vi
      .fn()
      .mockResolvedValueOnce(cargoRun({ cmake_pairs: "FAILED", go_pairs: "FAILED", attribution: "ok" }))
      .mockResolvedValueOnce(cargoRun({ cmake_pairs: "ok", go_pairs: "FAILED", attribution: "FAILED" }))
    const result = await executeGoalVerification(contract, await workspace(), {
      successCriteria,
      executeCommand,
      commandReruns: 1,
    })
    expect(result.ok).toBe(false)
    expect(result.evidence[0]?.checks[0]?.nondeterministic).toBeUndefined()
    expect(result.output).toContain("in each of 2 runs")
  })

  it("runs a failing command once when no rerun is configured, and never reruns a timeout", async () => {
    const once = vi.fn().mockResolvedValue(failed)
    const single = await executeGoalVerification(contract, await workspace(), { successCriteria, executeCommand: once })
    expect(once).toHaveBeenCalledTimes(1)
    expect(single.ok).toBe(false)

    const timedOut = vi.fn().mockResolvedValue({ exitCode: null, stdout: "", stderr: "timed out" })
    const result = await executeGoalVerification(contract, await workspace(), {
      successCriteria,
      executeCommand: timedOut,
      commandReruns: 1,
    })
    expect(timedOut).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(false)
  })

  it("reruns once by default and lets the operator turn reruns off", () => {
    expect(verificationReruns({})).toBe(1)
    expect(verificationReruns({ AV_VERIFICATION_RERUNS: "0" })).toBe(0)
    expect(verificationReruns({ AV_VERIFICATION_RERUNS: "2" })).toBe(2)
    expect(verificationReruns({ AV_VERIFICATION_RERUNS: "many" })).toBe(1)
  })

  it("charges an input once however often the same content is read, and again when it changes", async () => {
    const root = await verificationRoot(await workspace())
    const budget = { ...verificationBudget(), remaining: 20 }
    for (let read = 0; read < 5; read++) await readVerificationFile(root, "harness.test.js", budget)
    expect(budget.remaining).toBe(20 - "test fixture".length)
    await writeFile(join(root, "harness.test.js"), "changed fixture!")
    await expect(readVerificationFile(root, "harness.test.js", budget)).rejects.toThrow("evidence budget")
    // A caller without the ledger keeps the per-read charge.
    const plain = { remaining: 20 }
    await writeFile(join(root, "harness.test.js"), "test fixture")
    await readVerificationFile(root, "harness.test.js", plain)
    await expect(readVerificationFile(root, "harness.test.js", plain)).rejects.toThrow("evidence budget")
  })

  it("keeps later checks inside the evidence allowance after a rerun", async () => {
    const root = await workspace()
    await writeFile(join(root, "harness.test.js"), Buffer.alloc(4_000_000, "a"))
    const five = {
      version: 1,
      criteria: ["one", "two", "three", "four", "five"].map((criterion) => ({
        criterion,
        checks: [{ kind: "command", program: "node", args: ["--test", "harness.test.js"], timeoutMs: 120_000 }],
      })),
    }
    const executeCommand = vi.fn().mockResolvedValueOnce(failed).mockResolvedValue(passed)
    const result = await executeGoalVerification(five, root, {
      successCriteria: ["one", "two", "three", "four", "five"],
      executeCommand,
      commandReruns: 1,
    })
    expect(executeCommand).toHaveBeenCalledTimes(6)
    expect(result.ok).toBe(true)
    expect(result.output).not.toContain("evidence budget")
  })
})
