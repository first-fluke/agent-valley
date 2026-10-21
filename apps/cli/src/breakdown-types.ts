/** Breakdown contracts shared by the CLI prompt flow and issue publisher. */
export interface BreakdownSubIssue {
  title: string
  description: string
  blockedByIndices: number[]
}

export interface BreakdownResult {
  parentTitle: string
  parentDescription: string
  subIssues: BreakdownSubIssue[]
}
