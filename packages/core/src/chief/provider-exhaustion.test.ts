import { describe, expect, it } from "vitest"
import { EXHAUSTION_WINDOW_MS, recordExhaustion } from "./provider-exhaustion"

const at = (ms: number) => new Date(Date.parse("2026-10-05T00:00:00.000Z") + ms).toISOString()
const hour = 60 * 60 * 1_000
const child = (createdAt: string, exhaustedAgents: Array<"codex" | "qwen">) => ({
  createdAt,
  handoff: { exhaustedAgents, routes: {}, continuations: {} },
})

describe("provider exhaustion records", () => {
  it("records a provider the child found exhausted at the current time", () => {
    expect(recordExhaustion([], child(at(0), ["codex"]), at(hour))).toEqual([{ agentType: "codex", at: at(hour) }])
  })

  it("keeps the first time for a provider the child was started with", () => {
    const recorded = [{ agentType: "codex", at: at(0) }]

    // The child began two hours after the limit was met and ended nine hours after it.
    const next = recordExhaustion(recorded, child(at(2 * hour), ["codex"]), at(9 * hour))

    expect(next).toEqual(recorded)
    expect(Date.parse(at(9 * hour)) - Date.parse(next[0]?.at ?? "")).toBeGreaterThan(EXHAUSTION_WINDOW_MS)
  })

  it("keeps the first time when the same child reports its own finding again", () => {
    const first = recordExhaustion([], child(at(0), ["codex"]), at(hour))

    expect(recordExhaustion(first, child(at(0), ["codex"]), at(3 * hour))).toEqual(first)
  })

  it("renews a record that had lapsed before the child started", () => {
    const recorded = [
      { agentType: "codex", at: at(0) },
      { agentType: "qwen", at: at(0) },
    ]

    expect(recordExhaustion(recorded, child(at(7 * hour), ["codex"]), at(8 * hour))).toEqual([
      { agentType: "codex", at: at(8 * hour) },
      { agentType: "qwen", at: at(0) },
    ])
  })

  it("leaves the records alone for a child with no exhausted provider", () => {
    const recorded = [{ agentType: "codex", at: at(0) }]

    expect(recordExhaustion(recorded, { createdAt: at(hour) }, at(2 * hour))).toEqual(recorded)
  })
})
