import { describe, expect, it } from "vitest"
import { nondeterministicTests } from "./verification-nondeterminism"

const binary = (verdicts: Record<string, "ok" | "FAILED">): string => {
  const lines = Object.entries(verdicts).map(([name, verdict]) => `test ${name} ... ${verdict}`)
  const failures = lines.filter((line) => line.endsWith("FAILED")).length
  const verdict = failures ? "FAILED" : "ok"
  return `running ${lines.length} tests\n${lines.join("\n")}\n\ntest result: ${verdict}. ${lines.length - failures} passed; ${failures} failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n`
}
const run = (stdout: string, failedTargets: number, exitCode: number | null = 101) => ({
  exitCode,
  stdout,
  stderr: `error: ${failedTargets} target${failedTargets === 1 ? "" : "s"} failed:\n    \`-p crate --test suite\`\n`,
})

describe("nondeterministicTests", () => {
  it("names the tests when each one that failed passed in another run", () => {
    const first = run(binary({ a: "FAILED", b: "ok" }) + binary({ c: "ok" }), 1)
    const second = run(binary({ a: "ok", b: "ok" }) + binary({ c: "FAILED" }), 1)
    expect(nondeterministicTests([first, second])).toEqual(["a", "c"])
  })

  it("keeps the command failed when a test fails in every run", () => {
    const first = run(binary({ a: "FAILED", b: "FAILED" }), 1)
    const second = run(binary({ a: "FAILED", b: "ok" }), 1)
    expect(nondeterministicTests([first, second])).toBeUndefined()
  })

  it("keeps the command failed when a failed test did not run to a pass in another run", () => {
    // Without --no-fail-fast the second binary never ran in the first run.
    const first = {
      exitCode: 101,
      stdout: binary({ a: "FAILED" }),
      stderr: "error: test failed, to rerun pass `-p crate --test first`\n",
    }
    const second = {
      exitCode: 101,
      stdout: binary({ a: "ok" }) + binary({ c: "FAILED" }),
      stderr: "error: test failed, to rerun pass `-p crate --test second`\n",
    }
    expect(nondeterministicTests([first, second])).toBeUndefined()
  })

  it("keeps the command failed when a target failed without a named test", () => {
    // Two targets failed but only one printed a result: the other binary crashed or did not build.
    const first = run(binary({ a: "FAILED", b: "ok" }), 2)
    const second = run(binary({ a: "ok", b: "FAILED" }), 1)
    expect(nondeterministicTests([first, second])).toBeUndefined()
    const unnamed = run("error[E0425]: cannot find value\n", 1)
    expect(nondeterministicTests([unnamed, second])).toBeUndefined()
  })

  it("treats a name shared by two binaries as failed when either copy failed", () => {
    const first = run(binary({ shared: "FAILED" }) + binary({ shared: "ok" }), 1)
    const second = run(binary({ shared: "ok" }) + binary({ shared: "FAILED" }), 1)
    expect(nondeterministicTests([first, second])).toBeUndefined()
  })

  it("needs two completed failing runs", () => {
    const failing = run(binary({ a: "FAILED", b: "ok" }), 1)
    expect(nondeterministicTests([failing])).toBeUndefined()
    expect(nondeterministicTests([failing, run(binary({ a: "ok", b: "FAILED" }), 1, null)])).toBeUndefined()
  })
})
