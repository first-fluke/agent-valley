import { describe, expect, it } from "vitest"
import { commandFailureDetail, fileFailureDetail, jsonFailureDetail } from "./verification"

describe("verification command failure detail", () => {
  it("names the failing libtest case that only appears on stdout", () => {
    const stdout = [
      "running 3 tests",
      "test managed::exit_zero ... ok",
      "test managed::exit_17_is_failed ... FAILED",
      "",
      "failures:",
      "---- managed::exit_17_is_failed stdout ----",
      "thread 'managed::exit_17_is_failed' panicked at crates/arc-daemon/tests/managed_exec.rs:42:5:",
      "assertion `left == right` failed",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored",
    ].join("\n")
    const stderr =
      "     Running tests/managed_exec.rs (target/debug/deps/managed_exec-84bc)\nerror: test failed, to rerun pass `-p arc-daemon --test managed_exec`\n"
    const detail = commandFailureDetail(stdout, stderr)
    expect(detail).toContain("managed::exit_17_is_failed ... FAILED")
    expect(detail).toContain("panicked at crates/arc-daemon/tests/managed_exec.rs:42:5")
    expect(detail).toContain("to rerun pass `-p arc-daemon --test managed_exec`")
    expect(detail.length).toBeLessThanOrEqual(1_800)
  })

  it("stays bounded for noisy output and falls back to stream tails", () => {
    const detail = commandFailureDetail("x".repeat(50_000), "y".repeat(50_000))
    expect(detail.length).toBeLessThanOrEqual(1_800)
    expect(detail).toContain("stdout tail:")
    expect(detail).toContain("stderr tail:")
    expect(commandFailureDetail("", "only stderr")).toBe("stderr tail:\nonly stderr")
  })
})

describe("verification file and JSON failure detail", () => {
  it("names the JSON file, pointer, required value and observed value", () => {
    expect(
      jsonFailureDetail({ path: "evidence/qa.json", pointer: "/receiptBindingsVerified", equals: true }, false),
    ).toBe("evidence/qa.json pointer /receiptBindingsVerified must equal true; observed false.")
    expect(jsonFailureDetail({ path: "evidence/qa.json", pointer: "/missing", equals: 0 }, undefined)).toContain(
      "must equal 0; observed no value.",
    )
    expect(
      jsonFailureDetail({ path: "a.json", pointer: "/sequence", equals: ["Normal", "Critical"] }, "x".repeat(5_000))
        .length,
    ).toBeLessThan(400)
  })

  it("names the file and every unmet byte, hash and content assertion", () => {
    const detail = fileFailureDetail(
      { path: "evidence/final.md", minBytes: 200, sha256: "a".repeat(64), contains: ["Outstanding", "present"] },
      { bytes: 12, sha256: "b".repeat(64), text: "present only" },
    )
    expect(detail).toContain("evidence/final.md has 12 bytes, needs at least 200")
    expect(detail).toContain(`has SHA-256 ${"b".repeat(64)}, needs ${"a".repeat(64)}`)
    expect(detail).toContain('lacks required text "Outstanding"')
    expect(detail).not.toContain('"present"')
  })
})
