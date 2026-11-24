/**
 * Per-test verdicts across runs of one command on an unchanged workspace.
 *
 * A suite with several timing-sensitive tests can fail a different test in every run. Judging the command as
 * a whole then calls each run a defect: one mission failed verification in four of five runs, each time on
 * another test, and every failure reopened a finished task for a repair, a full integration check and a
 * review. A test is a defect of the delivery only when it fails in every run. One that passes in another run
 * on the same bytes is nondeterministic, exactly like a command that fails once and then passes.
 */
export interface CommandRun {
  exitCode: number | null
  stdout: string
  stderr: string
}

interface Verdicts {
  failed: Set<string>
  passed: Set<string>
}

/**
 * libtest verdict lines of one run, or nothing when the run failed for a reason no verdict line names: a
 * build error, a test binary that crashed, a timeout. The counts of the result lines and of Cargo's own
 * summary have to agree with the named failures, so no failure is left out of the comparison.
 */
function libtestVerdicts(run: CommandRun): Verdicts | undefined {
  const failed = new Set<string>()
  const passed = new Set<string>()
  let failures = 0
  for (const match of run.stdout.matchAll(/^test (.+) \.\.\. (ok|FAILED)\r?$/gm)) {
    const name = match[1] ?? ""
    if (match[2] === "ok") passed.add(name)
    else {
      failed.add(name)
      failures++
    }
  }
  let failedBinaries = 0
  let reported = 0
  for (const match of run.stdout.matchAll(/^test result: FAILED\. \d+ passed; (\d+) failed;/gm)) {
    failedBinaries++
    reported += Number(match[1])
  }
  const targets = /^error: (\d+) targets? failed:/m.exec(run.stderr)
  // Without --no-fail-fast Cargo stops at the first failing binary and names only that one.
  const failedTargets = targets ? Number(targets[1]) : /^error: test failed, to rerun pass /m.test(run.stderr) ? 1 : 0
  if (!failures || reported !== failures || failedTargets !== failedBinaries) return undefined
  return { failed, passed }
}

/**
 * The tests that failed, when every run failed only in named tests and each of those tests passed in another
 * run. Nothing when any test failed in every run, when a failed test never ran to a pass, or when a run
 * cannot be read as test verdicts; the command then stays failed.
 */
export function nondeterministicTests(runs: readonly CommandRun[]): string[] | undefined {
  if (runs.length < 2 || runs.some((run) => run.exitCode === null || run.exitCode === 0)) return undefined
  const verdicts: Verdicts[] = []
  for (const run of runs) {
    const parsed = libtestVerdicts(run)
    if (!parsed) return undefined
    verdicts.push(parsed)
  }
  const names = new Set(verdicts.flatMap((entry) => [...entry.failed]))
  // The same name can exist in two binaries: a run counts as a pass only when no test of that name failed.
  for (const name of names)
    if (!verdicts.some((entry) => entry.passed.has(name) && !entry.failed.has(name))) return undefined
  return [...names].sort()
}
