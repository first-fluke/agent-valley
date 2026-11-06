import { afterEach, describe, expect, it, vi } from "vitest"
import { installHooks } from "./install-hooks.mjs"

afterEach(() => vi.restoreAllMocks())

describe("HK prepare", () => {
  it.each(["true", "1"])("skips hook provisioning in CI=%s", (CI) => {
    const run = vi.fn()
    expect(installHooks({ env: { CI }, exists: () => true, run })).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it("skips a source archive without Git metadata", () => {
    const run = vi.fn()
    expect(installHooks({ env: {}, exists: () => false, run })).toBe(0)
    expect(run).not.toHaveBeenCalled()
  })

  it.each([undefined, "false", "0"])("installs local mise hooks with CI=%s", (CI) => {
    const run = vi.fn().mockReturnValue({ status: 0 })
    const exists = vi.fn().mockReturnValue(true)
    expect(installHooks({ root: "/project with spaces", env: { CI, PATH: "/bin" }, exists, run })).toBe(0)
    expect(exists).toHaveBeenCalledWith("/project with spaces/.git")
    expect(run).toHaveBeenCalledExactlyOnceWith("mise", ["exec", "--", "hk", "install", "--mise"], {
      cwd: "/project with spaces",
      env: {
        CI,
        PATH: "/bin",
        MISE_AUTO_INSTALL: "0",
        MISE_EXEC_AUTO_INSTALL: "0",
      },
      stdio: "inherit",
    })
  })

  it("fails with repair instructions when a pinned tool is unavailable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    expect(
      installHooks({
        env: {},
        exists: () => true,
        run: () => ({ status: null, error: new Error("ENOENT") }),
      }),
    ).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining("mise.toml"))
  })

  it("preserves a failed HK install status", () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    expect(installHooks({ env: {}, exists: () => true, run: () => ({ status: 7 }) })).toBe(7)
  })
})
