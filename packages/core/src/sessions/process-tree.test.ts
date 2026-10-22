import type { ChildProcess } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"
import { signalProcessTree } from "./process-tree"

const denied = () => Object.assign(new Error("kill EPERM"), { code: "EPERM" })
const gone = () => Object.assign(new Error("kill ESRCH"), { code: "ESRCH" })
const fixture = () => ({ pid: 987654, exitCode: 0, signalCode: null, kill: vi.fn() }) as unknown as ChildProcess

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
})
