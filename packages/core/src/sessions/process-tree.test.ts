import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { signalProcessTree } from "./process-tree"

const denied = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" })
const gone = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
const fixture = (exitCode: number | null = 0) =>
  ({ pid: 987654, exitCode, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess

afterEach(() => vi.restoreAllMocks())
describe.skipIf(process.platform === "win32")("process group cleanup", () => {
  it("accepts a signal denial only when a subsequent probe proves the entire group disappeared", () => {
    const proc = fixture()
    const signal = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => {
        throw denied()
      })
      .mockImplementationOnce(() => {
        throw gone()
      })
    expect(() => signalProcessTree(proc, "SIGKILL")).not.toThrow()
    expect(signal.mock.calls).toEqual([
      [-987654, "SIGKILL"],
      [-987654, 0],
    ])
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it.each(["live", "uninspectable"] as const)("preserves denial for a %s group despite an exited leader", (state) => {
    const error = denied()
    const signal = vi
      .spyOn(process, "kill")
      .mockImplementationOnce(() => {
        throw error
      })
      .mockImplementationOnce(() => {
        if (state === "uninspectable") throw denied()
        return true
      })
    expect(() => signalProcessTree(fixture(), "SIGKILL")).toThrow(error)
    expect(signal).toHaveBeenCalledWith(-987654, 0)
  })

  it("accepts a stale child handle denial only after both its group and positive PID are proven gone", () => {
    // The OS process has exited, but ChildProcess exit/signal callbacks have not run.
    const proc = fixture(null)
    const error = denied()
    vi.mocked(proc.kill).mockImplementation(() => {
      throw error
    })
    const signal = vi.spyOn(process, "kill").mockImplementation(() => {
      throw gone()
    })

    expect(() => signalProcessTree(proc, "SIGKILL")).not.toThrow()
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
    expect(signal).toHaveBeenCalledWith(-987654, "SIGKILL")
    expect(signal).toHaveBeenCalledWith(-987654, 0)
    expect(signal).toHaveBeenCalledWith(987654, 0)
  })

  it.each([
    ["live group", -987654, "live"],
    ["live positive PID", 987654, "live"],
    ["uninspectable group", -987654, "uninspectable"],
    ["uninspectable positive PID", 987654, "uninspectable"],
  ] as const)("preserves a stale handle's original denial for a %s", (_label, uncertainPid, state) => {
    const proc = fixture(null)
    const original = denied()
    vi.mocked(proc.kill).mockImplementation(() => {
      throw original
    })
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === "SIGKILL" || pid !== uncertainPid) throw gone()
      if (state === "uninspectable") throw denied()
      return true
    })

    let actual: unknown
    try {
      signalProcessTree(proc, "SIGKILL")
    } catch (error) {
      actual = error
    }
    expect(actual).toBe(original)
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL")
  })
})
