/**
 * isProcessAlive unit tests — mocks process.kill so no real PID is probed.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { isProcessAlive } from "../orchestrator/persistence/liveness"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("isProcessAlive", () => {
  test("returns true when process.kill(pid, 0) succeeds", () => {
    vi.spyOn(process, "kill").mockImplementation(() => true)
    expect(isProcessAlive(4242)).toBe(true)
  })

  test("returns false on ESRCH (no such process)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill ESRCH") as NodeJS.ErrnoException
      err.code = "ESRCH"
      throw err
    })
    expect(isProcessAlive(4242)).toBe(false)
  })

  test("returns true on EPERM (process exists, we lack permission to signal it)", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      const err = new Error("kill EPERM") as NodeJS.ErrnoException
      err.code = "EPERM"
      throw err
    })
    expect(isProcessAlive(4242)).toBe(true)
  })

  test("returns false conservatively on any other error", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("unexpected")
    })
    expect(isProcessAlive(4242)).toBe(false)
  })
})
