import { describe, expect, test, vi } from "vitest"
import { generateNodeId } from "./node-id"

vi.mock("node:os", () => ({ hostname: () => "Workstation.LOCAL" }))

describe("generateNodeId", () => {
  test("prefixes the hostname with the authenticated user UUID", () => {
    expect(generateNodeId("A1A1A1A1-1111-4111-8111-111111111111")).toBe(
      "a1a1a1a1-1111-4111-8111-111111111111:workstation",
    )
  })

  test("rejects a display name or OS username in place of authenticated identity", () => {
    expect(() => generateNodeId("alice")).toThrow(/av login/)
  })
})
