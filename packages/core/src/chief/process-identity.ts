import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

export function processIdentity(pid: number): string | undefined {
  try {
    const identity =
      process.platform === "linux"
        ? readFileSync(`/proc/${pid}/stat`, "utf8")
            .slice(readFileSync(`/proc/${pid}/stat`, "utf8").lastIndexOf(")") + 2)
            .split(" ")[19]
        : execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
            encoding: "utf8",
            timeout: 1_000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim()
    return identity ? createHash("sha256").update(identity).digest("hex") : undefined
  } catch {
    return undefined
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}
