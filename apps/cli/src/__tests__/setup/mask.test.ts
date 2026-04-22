import { describe, expect, it } from "vitest"
import { maskApiKey, maskSecret } from "../../setup/mask"

describe("maskApiKey", () => {
  it("keeps prefix + last 4 of long keys", () => {
    expect(maskApiKey("lin_api_abcdef123456")).toBe("lin_api_****3456")
  })

  it("returns **** for short keys", () => {
    expect(maskApiKey("short")).toBe("****")
    expect(maskApiKey("exactly12ch")).toBe("****")
  })
})

describe("maskSecret", () => {
  it("keeps last 4 for moderately long values", () => {
    expect(maskSecret("abcdefghij")).toBe("****ghij")
  })

  it("fully masks short values", () => {
    expect(maskSecret("short")).toBe("****")
    expect(maskSecret("eight123")).toBe("****")
  })

  it("returns empty string for empty input", () => {
    expect(maskSecret("")).toBe("")
  })
})
