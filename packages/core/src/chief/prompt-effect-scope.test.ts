import { describe, expect, it } from "vitest"
import { fixture } from "./goal-supervision.fixture"
import { planPrompt, supervisePrompt } from "./prompts"

describe("effectScope prompt guidance", () => {
  it("clarifies allowed effectScope values in supervisePrompt", () => {
    const { mission } = fixture()
    const prompt = supervisePrompt(mission)
    expect(prompt).toContain(
      'Optional effectScope only accepts "workspace" or "external" (omit it or use "workspace" for read-only/normal workspace tasks).',
    )
  })

  it("clarifies allowed effectScope values in planPrompt", () => {
    const { mission } = fixture()
    const prompt = planPrompt(mission)
    expect(prompt).toContain(
      'Optional effectScope only accepts "workspace" or "external" (omit it or use "workspace" for read-only/normal workspace tasks).',
    )
  })
})
