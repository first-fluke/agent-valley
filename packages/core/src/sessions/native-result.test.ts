import { describe, expect, it } from "vitest"
import { BoundedResultText, MAX_NATIVE_RESULT_LENGTH } from "./native-result"

describe("BoundedResultText", () => {
  it("accumulates chunks in order within the bound", () => {
    const buffer = new BoundedResultText()
    buffer.append("first ")
    buffer.append("second")
    expect(buffer.text).toBe("first second")
    expect(buffer.exceeded).toBe(false)
  })

  it("accepts text exactly at the shared bound", () => {
    const buffer = new BoundedResultText()
    buffer.append("x".repeat(MAX_NATIVE_RESULT_LENGTH - 1))
    buffer.append("x")
    expect(buffer.text.length).toBe(MAX_NATIVE_RESULT_LENGTH)
    expect(buffer.exceeded).toBe(false)
  })

  it("discards the text and stays exceeded when a chunk crosses the bound", () => {
    const buffer = new BoundedResultText()
    buffer.append("x".repeat(MAX_NATIVE_RESULT_LENGTH))
    buffer.append("x")
    expect(buffer.exceeded).toBe(true)
    expect(buffer.text).toBe("")
  })

  it("rejects a single oversized chunk", () => {
    const buffer = new BoundedResultText()
    buffer.append("x".repeat(MAX_NATIVE_RESULT_LENGTH + 1))
    expect(buffer.exceeded).toBe(true)
    expect(buffer.text).toBe("")
  })

  it("ignores appends after overflow until reset", () => {
    const buffer = new BoundedResultText()
    buffer.append("x".repeat(MAX_NATIVE_RESULT_LENGTH + 1))
    buffer.append("late")
    expect(buffer.exceeded).toBe(true)
    expect(buffer.text).toBe("")
    buffer.reset()
    expect(buffer.exceeded).toBe(false)
    buffer.append("next run")
    expect(buffer.text).toBe("next run")
  })
})
