import { describe, expect, it } from "vitest"
import {
  activeCharterAmendments,
  charterAmendmentsSchema,
  nextCharterAmendments,
  operationSchema,
} from "./continuous-contract"
import { operation, timestamp } from "./continuous-operation.fixture"

describe("operator charter amendments", () => {
  it("appends sequential corrections without rewriting the original charter or the caller's record", () => {
    const record = operation()
    const first = nextCharterAmendments(record, { text: "The actor sandbox now permits /tmp writes." }, timestamp)
    const second = nextCharterAmendments(
      { ...record, charterAmendments: first },
      { text: "Use only the staging API." },
      timestamp,
    )
    expect(record.charter).toBe("Keep improving usability and revenue")
    expect(record.charterAmendments).toBeUndefined()
    expect(second).toEqual([
      { id: 1, at: timestamp, text: "The actor sandbox now permits /tmp writes." },
      { id: 2, at: timestamp, text: "Use only the staging API." },
    ])
    expect(operationSchema.parse({ ...record, charterAmendments: second }).charterAmendments).toEqual(second)
  })

  it("retracts superseded amendments from the instruction set while retaining them for audit", () => {
    const record = operation()
    const first = nextCharterAmendments(record, { text: "Avoid /tmp writes." }, timestamp)
    const second = nextCharterAmendments(
      { ...record, charterAmendments: first },
      { text: "/tmp writes are permitted; disregard the earlier caution.", supersedes: [1, 1] },
      timestamp,
    )
    const amended = { ...record, charterAmendments: second }
    expect(second).toEqual([
      { id: 1, at: timestamp, text: "Avoid /tmp writes." },
      { id: 2, at: timestamp, text: "/tmp writes are permitted; disregard the earlier caution.", supersedes: [1] },
    ])
    expect(activeCharterAmendments(amended).map((entry) => entry.id)).toEqual([2])
    expect(amended.charterAmendments).toHaveLength(2)
    const third = nextCharterAmendments(amended, { text: "Use production again.", supersedes: [2] }, timestamp)
    expect(activeCharterAmendments({ ...record, charterAmendments: third }).map((entry) => entry.id)).toEqual([3])
  })

  it("keeps records saved before amendments valid and unamended", () => {
    expect(operationSchema.parse(operation()).charterAmendments).toBeUndefined()
    expect(activeCharterAmendments(operation())).toEqual([])
  })

  it("rejects unknown and non-earlier supersede targets with repair instructions", () => {
    const record = operation()
    expect(() => nextCharterAmendments(record, { text: "Correction", supersedes: [1] }, timestamp)).toThrow(
      "Charter amendment 1 is not recorded",
    )
    const first = nextCharterAmendments(record, { text: "First" }, timestamp)
    expect(() =>
      nextCharterAmendments({ ...record, charterAmendments: first }, { text: "Second", supersedes: [2] }, timestamp),
    ).toThrow("not recorded")
    expect(charterAmendmentsSchema.safeParse([{ id: 2, at: timestamp, text: "Out of order" }]).success).toBe(false)
    expect(
      charterAmendmentsSchema.safeParse([
        { id: 1, at: timestamp, text: "First" },
        { id: 2, at: timestamp, text: "Self reference", supersedes: [2] },
      ]).success,
    ).toBe(false)
    expect(
      charterAmendmentsSchema.safeParse([
        { id: 1, at: timestamp, text: "First" },
        { id: 2, at: timestamp, text: "Retraction", supersedes: [1] },
      ]).success,
    ).toBe(true)
  })

  it("bounds each amendment, the amendment count and their total text budget", () => {
    expect(charterAmendmentsSchema.safeParse([{ id: 1, at: timestamp, text: "   " }]).success).toBe(false)
    expect(charterAmendmentsSchema.safeParse([{ id: 1, at: timestamp, text: "x".repeat(8_001) }]).success).toBe(false)
    const entry = (id: number, text: string) => ({ id, at: timestamp, text })
    expect(
      charterAmendmentsSchema.safeParse(Array.from({ length: 4 }, (_, index) => entry(index + 1, "x".repeat(7_000))))
        .success,
    ).toBe(true)
    expect(
      charterAmendmentsSchema.safeParse(Array.from({ length: 5 }, (_, index) => entry(index + 1, "x".repeat(7_000))))
        .success,
    ).toBe(false)
    expect(
      charterAmendmentsSchema.safeParse(Array.from({ length: 51 }, (_, index) => entry(index + 1, "x"))).success,
    ).toBe(false)
  })
})
