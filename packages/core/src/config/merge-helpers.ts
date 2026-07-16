/**
 * Config merge helpers — pure precedence/resolution logic extracted from
 * yaml-loader.ts to keep that file within the 500-line cap (CONSTRAINTS.md §5).
 */

/**
 * Resolve effective agent concurrency.
 *
 * An explicit `agent.max_parallel` from project/global config wins over the
 * hardware-derived recommendation. A value above the recommendation is honored
 * (not clamped) but warns about the resource-exhaustion risk so the operator
 * can self-correct. `explicit` is the already-resolved project > global value
 * (undefined when neither file sets it).
 */
export function resolveMaxParallel(explicit: number | undefined, recommended: number): number {
  if (explicit === undefined) return recommended

  if (explicit > recommended) {
    console.warn(
      `WARN: agent.max_parallel (${explicit}) exceeds the hardware-recommended concurrency (${recommended}). ` +
        "Running more agents than recommended may exhaust CPU/RAM and degrade performance. " +
        "Proceeding with the configured value.",
    )
  }

  return explicit
}
