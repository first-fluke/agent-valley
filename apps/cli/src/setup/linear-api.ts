/**
 * Linear API helpers used by the setup wizard.
 *
 * Kept as pure functions (no clack / readline coupling) so they can be
 * unit-tested without mocking the TUI layer.
 */

import type { WorkflowState } from "./types"

export async function linearQuery(apiKey: string, query: string): Promise<Record<string, unknown>> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) throw new Error(`Linear API HTTP ${res.status}`)

  const data = (await res.json()) as { data?: Record<string, unknown>; errors?: { message: string }[] }
  if (data.errors) throw new Error(data.errors[0]?.message)

  if (!data.data) throw new Error("Linear API returned no data")
  return data.data
}

/**
 * Locate a workflow state by preferred names, falling back to the first
 * state whose `type` matches. Returns `undefined` when neither path hits.
 */
export function findWorkflowState(states: WorkflowState[], names: string[], type: string): WorkflowState | undefined {
  return states.find((st) => names.includes(st.name)) ?? states.find((st) => st.type === type)
}
