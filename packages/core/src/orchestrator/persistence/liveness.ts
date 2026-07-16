/**
 * Liveness probe — checks whether an OS process id is still alive,
 * without sending it a real signal (`process.kill(pid, 0)` is a no-op
 * probe on POSIX and Node's Windows shim).
 *
 * Exported standalone so boot recovery (`./recovery.ts`) can be unit
 * tested by injecting a fake probe instead of touching real PIDs.
 */

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // ESRCH: no such process — definitely dead.
    if (code === "ESRCH") return false
    // EPERM: process exists but we lack permission to signal it — treat as alive.
    if (code === "EPERM") return true
    // Any other unexpected error — cannot confirm liveness, treat as dead
    // so recovery reaps conservatively rather than silently reattaching.
    return false
  }
}
