import type { Review } from "./contracts"

/** The four grounds on which a repair review may reject; each blocking finding starts with one of them. */
const REPAIR_GROUND = /^\s*(UNRESOLVED|CHANGED|CHECK|SEVERE)\s*:/i
const CHANGED_GROUND = /^\s*CHANGED\s*:/i

/**
 * Enforces the repair-review boundary instead of only asking for it. A repair review rejects for an earlier
 * finding that is still open, a defect in what the task changed, a failed integration check or a severe
 * defect. Reviewers used to add newly noticed concerns about untouched code in every round, and each one
 * cost another Actor run, integration check and review: one mission rejected six tasks 22 times.
 *
 * The reviewer labels every blocking finding with its ground. Unlabelled findings, and CHANGED findings
 * that name no file of the task's delivery, become follow-ups; a review left without a blocking finding
 * passes. A rejection that labels nothing is left as it is: the reviewer ignored the format, and guessing
 * which of its findings block would accept unreviewed defects.
 */
export function settleRepairReview(
  review: Review,
  previous: Review | undefined,
  changedPaths?: readonly string[],
): Review {
  if (!previous || previous.passed || review.passed) return review
  if (!review.findings.some((finding) => REPAIR_GROUND.test(finding))) return review
  const names = (changedPaths ?? []).flatMap((path) => [path, path.split("/").at(-1) ?? path])
  const blocks = (finding: string) =>
    REPAIR_GROUND.test(finding) &&
    !(CHANGED_GROUND.test(finding) && names.length > 0 && !names.some((name) => finding.includes(name)))
  const blocking = review.findings.filter(blocks)
  const demoted = review.findings.filter((finding) => !blocks(finding))
  if (!demoted.length) return review
  const followUps = [...(review.followUps ?? []), ...demoted].slice(0, 50)
  const note = ` Agent Valley recorded ${demoted.length} finding(s) outside the repair boundary as follow-ups.`
  const summary = `${review.summary}${note}`.slice(0, 32_000)
  return blocking.length
    ? { ...review, summary, findings: blocking, followUps }
    : { ...review, passed: true, summary, findings: [], followUps }
}

/** Keep every advisory and independent review on the same wire response contract. */
export function reviewResponseFormat(
  summary: string,
  criteria?: string[],
  options: { followUps?: boolean; repairReview?: boolean } = {},
): string {
  const passing = {
    passed: true,
    summary,
    findings: [] as string[],
    ...(options.followUps ? { followUps: [] as string[] } : {}),
    ...(criteria
      ? {
          criteria: criteria.map((criterion) => ({
            criterion,
            passed: true,
            evidence: "actual inspected path or check",
          })),
        }
      : {}),
  }
  const rejected = {
    ...passing,
    passed: false,
    summary: "An inspected requirement or evidence gap needs attention.",
    findings: [
      options.repairReview
        ? "UNRESOLVED: '<quote prior finding>' Evidence: cite the inspected path or failed check. Action: give the concrete repair or next check."
        : "Concern: describe the gap. Evidence: cite the inspected path or failed check. Action: give the concrete repair or next check.",
    ],
    ...(passing.criteria
      ? { criteria: passing.criteria.map((entry, index) => ({ ...entry, passed: index !== 0 })) }
      : {}),
  }
  return [
    "Return ONLY one JSON object under 8,000 characters, without Markdown fences or text outside JSON.",
    `Use strictly and only these top-level keys: passed, summary, findings${options.followUps ? ", followUps" : ""}${criteria ? ", criteria" : ""}. Do not add other top-level keys, extra/comment keys (such as "_" or "notes"), or wrap the response in another object — any unrecognized key fails strict schema validation.`,
    ...(options.followUps
      ? [
          "followUps is an array of at most 50 nonempty strings and may be empty. It holds concerns that do not fail this review; they are recorded in the mission report and never cause another repair. A response may pass with followUps.",
        ]
      : []),
    "passed must be a boolean, summary must be a nonempty string, and findings must be an array of nonempty strings with at most 50 entries. Do not put objects, arrays, numbers or null in findings. Put each concern, inspected basis and concrete recommendation together inside one finding string; do not use concern/basis/recommendation objects.",
    "Use findings:[] for passed:true. For passed:false, include at least one actionable finding. Do not omit required keys.",
    ...(criteria
      ? [
          "criteria must assess every requested criterion exactly once. Each criteria entry has exactly criterion, passed and evidence: criterion and evidence are nonempty strings, and passed is a boolean. Use the exact criterion text and actual inspected evidence. Overall passed must equal all criteria passing.",
        ]
      : []),
    "The examples show response structure only. Replace example descriptions with actual inspected evidence; never claim an example check was performed.",
    `Passing response example:\n${JSON.stringify(passing)}`,
    `Rejected response example:\n${JSON.stringify(rejected)}`,
  ].join("\n\n")
}
