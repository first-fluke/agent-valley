import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { executeGoalVerification, verificationReruns } from "./verification"

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
})
