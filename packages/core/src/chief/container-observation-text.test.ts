import { describe, expect, it } from "vitest"
import { sanitizeContainerText } from "./container-observation-text"

describe("container diagnostic secret reduction", () => {
  it("redacts inline access/private keys and password-bearing URIs for any protocol", () => {
    const text =
      "ERROR access_key=fixture-access-value private_key=fixture-private-value redis://alice:fixture-password@host:6379/0 mongodb://alice:fixture-password@host/db"
    const sanitized = sanitizeContainerText(text, {})
    for (const value of ["fixture-access-value", "fixture-private-value", "fixture-password"])
      expect(sanitized).not.toContain(value)
    expect(sanitized).toContain("redis://[redacted]@host")
    expect(sanitized).toContain("mongodb://[redacted]@host")
  })

  it("redacts known credential env values even when short, opaque, encoded or unlabelled", () => {
    const value = "opaque/fixture+secret"
    const text = `ERROR raw ${value} encoded ${encodeURIComponent(value)} short q7`
    const sanitized = sanitizeContainerText(text, { SERVICE_API_KEY: value, SESSION_TOKEN: "q7", EMPTY_SECRET: "" })
    expect(sanitized).not.toContain(value)
    expect(sanitized).not.toContain(encodeURIComponent(value))
    expect(sanitized).not.toContain("q7")
  })

  it("redacts standalone provider token forms and JWTs before report excerpt truncation", () => {
    const tokens = [
      ["g", "h", "p", "_"].join("") + "a".repeat(36),
      ["g", "i", "t", "h", "u", "b", "_", "p", "a", "t", "_"].join("") + "a".repeat(40),
      ["n", "p", "m", "_"].join("") + "a".repeat(36),
      ["s", "k", "-", "a", "n", "t", "-"].join("") + "a".repeat(36),
      ["x", "o", "x", "b", "-"].join("") + "a".repeat(36),
      ["A", "K", "I", "A"].join("") + "A".repeat(16),
      ["y", "a", "2", "9", "."].join("") + "a".repeat(36),
      `${["e", "y", "J"].join("")}${"a".repeat(12)}.${"b".repeat(20)}.${"c".repeat(20)}`,
    ]
    const sanitized = sanitizeContainerText(`ERROR ${tokens.join(" ")}`, {})
    for (const token of tokens) expect(sanitized).not.toContain(token)
  })

  it("removes control and invisible formatting before interpreting assignments", () => {
    expect(sanitizeContainerText("ERROR access\u200b_key=fixture-access-value\u0000", {})).not.toContain(
      "fixture-access-value",
    )
    expect(sanitizeContainerText("INFO line\nINFO next", {})).toBe("INFO line\nINFO next")
  })

  it("handles JSON-escaped quoted passwords and overlapping short credentials without expanding markers repeatedly", () => {
    const escapedPassword = JSON.stringify('fixture\\quoted"password')
    expect(sanitizeContainerText(`ERROR password=${escapedPassword}`, {})).not.toContain("fixture")
    const text = "-----BEGIN PRIVATE KEY-----\nfixture-private-material\n-----END PRIVATE KEY-----"
    const sanitized = sanitizeContainerText(text, { FIRST_TOKEN: "P", SECOND_SECRET: "r", THIRD_PASSWORD: "e" })
    expect(sanitized).not.toContain("fixture-private-material")
    expect(sanitized.length).toBeLessThan(500)
  })
})
