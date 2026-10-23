/** Keep every advisory and independent review on the same wire response contract. */
export function reviewResponseFormat(summary: string, criteria?: string[]): string {
  const passing = {
    passed: true,
    summary,
    findings: [] as string[],
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
      "Concern: describe the gap. Evidence: cite the inspected path or failed check. Action: give the concrete repair or next check.",
    ],
    ...(passing.criteria
      ? { criteria: passing.criteria.map((entry, index) => ({ ...entry, passed: index !== 0 })) }
      : {}),
  }
  return [
    "Return ONLY one JSON object under 8,000 characters, without Markdown fences or text outside JSON.",
    `Use exactly these top-level keys: passed, summary, findings${criteria ? ", criteria" : ""}. Do not add other top-level keys or wrap the response in another object.`,
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
