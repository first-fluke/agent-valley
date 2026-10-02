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
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    if (proc.exitCode === null && proc.signalCode == null) proc.kill(signal)
  }
}
