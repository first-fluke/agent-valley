import { type ChildProcess, spawn } from "node:child_process"

/** Sessions and verification commands start in their own POSIX process group. */
export function signalProcessTree(proc: ChildProcess, signal: "SIGTERM" | "SIGKILL"): void {
  if (!proc.pid) return
  if (process.platform === "win32") {
    const args = ["/pid", String(proc.pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])]
    const killer = spawn("taskkill", args, { stdio: "ignore" })
    killer.once("error", () => proc.kill(signal))
    return
  }
  try {
    // The leader can exit while its children still own the group.
    process.kill(-proc.pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      try {
        process.kill(-proc.pid, 0)
      } catch (probeError) {
        // Natural exit can race the signal. Only absence of the full group
        // proves cleanup; a live or uninspectable group remains uncertain.
        if ((probeError as NodeJS.ErrnoException).code === "ESRCH") return
      }
      throw error
    }
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    if (proc.exitCode === null && proc.signalCode == null) {
      try {
        proc.kill(signal)
      } catch (handleError) {
        // A child handle can lag OS exit. Never suppress a permission failure
        // unless both the group and leader are independently proven absent.
        if ((handleError as NodeJS.ErrnoException).code === "EPERM" && rootAndGroupAbsent(proc.pid)) return
        throw handleError
      }
    }
  }
}

/** Absence of this root PID and its detached process group, not all descendants. */
export function rootAndGroupAbsent(pid: number): boolean {
  return absent(-pid) && absent(pid)
}

function absent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
  }
}
