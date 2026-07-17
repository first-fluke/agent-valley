/**
 * `av doctor` — one-shot diagnostic for "why isn't it working".
 *
 * Runs every check in doctor-checks.ts and prints a ✓/✗/⚠ line per check
 * with an actionable fix on failure. Exit code is 0 only when every
 * CRITICAL check (config, the configured agent CLI's install, the OS
 * sandbox binary) passes — so this is CI-usable as a health gate.
 * Non-critical checks (agent auth heuristic, tunnel, webhook secret) are
 * still reported and can fail without affecting the exit code, since
 * they are either best-effort probes or don't block the orchestrator
 * from starting.
 *
 * No real agent/LLM spawn happens here — every check is a filesystem
 * read or a PATH scan, so `av doctor` is fast and free to run.
 *
 * NOT YET WIRED into the commander `program` in index.ts — that file is
 * being edited concurrently by another agent. Call
 * `registerDoctorCommand(program)` once from index.ts to add the
 * `av doctor` command:
 *
 *   import { registerDoctorCommand } from "./doctor"
 *   registerDoctorCommand(program)
 */

import type { Command } from "commander"
import pc from "picocolors"
import { AGENT_TYPES, type CheckResult, type DoctorDeps, defaultDoctorDeps } from "./doctor-checks"
import { computeExitCode, runDoctorChecks, summarize } from "./doctor-config-checks"

const ICONS: Record<CheckResult["status"], string> = {
  pass: pc.green("✓"),
  fail: pc.red("✗"),
  warn: pc.yellow("⚠"),
  unknown: pc.dim("?"),
}

function printResult(r: CheckResult): void {
  console.log(`${ICONS[r.status]} ${r.name} — ${r.message}`)
  if (r.fix && r.status !== "pass") {
    console.log(pc.dim(`    Fix: ${r.fix}`))
  }
}

export interface DoctorOptions {
  all?: boolean
}

/**
 * Run every diagnostic check and print the report. Returns the process
 * exit code the caller should use (0 = all critical checks passed).
 * `deps` is injectable for tests; production callers omit it and get
 * `defaultDoctorDeps()`.
 */
export async function doctor(options: DoctorOptions = {}, deps: DoctorDeps = defaultDoctorDeps()): Promise<number> {
  console.log(pc.bold("Agent Valley — av doctor"))
  console.log()

  const results = await runDoctorChecks(deps, { allAgents: options.all })
  for (const r of results) printResult(r)

  const { passed, total } = summarize(results)
  const exitCode = computeExitCode(results)

  console.log()
  console.log(pc.bold(`${passed}/${total} checks passed`))
  if (exitCode !== 0) {
    console.log(pc.red('Critical checks failed — see "Fix:" lines above.'))
  }

  return exitCode
}

/**
 * Register `av doctor` on an existing commander program. Exported as a
 * standalone function rather than mutating a module-level `program`
 * singleton so this file has no coupling to index.ts's current edit
 * state or import order.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose install/config/auth problems (one-shot health check)")
    .option("-a, --all", `Check all ${AGENT_TYPES.length} supported agent CLIs, not just the configured one`)
    .action(async (opts: { all?: boolean }) => {
      const exitCode = await doctor({ all: opts.all })
      process.exit(exitCode)
    })
}
