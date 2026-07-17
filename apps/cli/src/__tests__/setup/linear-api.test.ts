import { describe, expect, it } from "vitest"
import { findWorkflowState, randomWebhookSecret } from "../../setup/linear-api"
import type { WorkflowState } from "../../setup/types"

describe("randomWebhookSecret", () => {
  it("returns a 64-character hex string (32 random bytes)", () => {
    const s = randomWebhookSecret()
    expect(s).toMatch(/^[0-9a-f]{64}$/)
  })

  it("returns different values on repeated calls", () => {
    const a = randomWebhookSecret()
    const b = randomWebhookSecret()
    expect(a).not.toBe(b)
  })
})

describe("findWorkflowState", () => {
  const states: WorkflowState[] = [
    { id: "s1", name: "Todo", type: "unstarted" },
    { id: "s2", name: "In Progress", type: "started" },
    { id: "s3", name: "Done", type: "completed" },
  ]

  it("matches by preferred name first", () => {
    expect(findWorkflowState(states, ["Todo"], "unstarted")?.id).toBe("s1")
  })

  it("falls back to matching by type when no name matches", () => {
    expect(findWorkflowState(states, ["Backlog"], "unstarted")?.id).toBe("s1")
  })

  it("returns undefined when neither name nor type match", () => {
    expect(findWorkflowState(states, ["Nope"], "canceled")).toBeUndefined()
  })
})
