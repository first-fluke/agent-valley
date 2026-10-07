import { describe, expect, it, vi } from "vitest"
import { inspectSkillCompatibility, type SkillCompatibilityPolicy, type SkillMatrixDeps } from "./skill-matrix-adapter"
import { parseSkillMatrix } from "./skill-matrix-io"

const hash = "a".repeat(64)
const now = Date.parse("2026-10-07T00:00:00Z")
const policy: SkillCompatibilityPolicy = { reportPath: "/audit.json", maxAgeHours: 168, mode: "require" }
const route = { actorType: "claude", model: "measured-model" }
function first<T>(values: T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error("Fixture entry is missing")
  return value
}

function report() {
  return {
    schemaVersion: 1,
    kind: "skill-compatibility-matrix",
    protocolVersion: "oma-skill-matrix-v2",
    mode: "live",
    status: "completed",
    createdAt: new Date(now).toISOString(),
    omaVersion: "16.0.0",
    host: { platform: "darwin", arch: "arm64", node: "v26" },
    suiteHash: hash,
    sourceKind: "installed",
    delivery: "injected",
    auditScope: "read-reference",
    bundle: {
      hash,
      skills: [
        {
          name: "oma-debug",
          hash,
          caseId: "read-oma-debug",
          requiredFiles: ["oma-debug/SKILL.md", "oma-debug/references/guide.md", "_shared/core/policy.md"],
          missingFiles: [] as string[],
          excludedReferences: [] as Array<{ path: string; reason: string }>,
        },
      ],
    },
    cases: [{ id: "read-oma-debug", skill: "oma-debug" }],
    models: { claude: "requested-alias", codex: null },
    cells: [
      {
        caseId: "read-oma-debug",
        skill: "oma-debug",
        vendor: "claude",
        status: "pass",
        contentHash: hash,
        checks: [
          "process",
          "output",
          "content",
          "integrity",
          "reference-coverage",
          "reference:references/guide.md",
          "reference:../_shared/core/policy.md",
        ].map((id) => ({
          id,
          status: "pass",
          detail: "Observed check",
          ...(id === "content" || id.startsWith("reference:") ? { proof: "read" } : {}),
        })),
        nativeActivation: "unobserved",
        cliVersion: "2.1.0",
        model: "measured-model",
        durationMs: 1,
      },
    ],
  }
}
function deps(saved = report(), current = report()): SkillMatrixDeps {
  return {
    now: () => now,
    platform: "darwin",
    arch: "arm64",
    readReport: vi.fn(async () => saved),
    plan: vi.fn(async () => ({ ...current, mode: "plan", status: "planned", cells: [] })),
    cliVersion: vi.fn(async () => "2.1.0"),
  }
}
async function inspect(saved = report(), current = report(), candidate = route) {
  return (
    await inspectSkillCompatibility(policy, "/mission/worktree", ["oma-debug"], [candidate], deps(saved, current))
  ).routes[0]
}

describe("cached skill matrix eligibility", () => {
  it("uses observed models, permits unobserved activation, and plans against the current task worktree", async () => {
    const injected = deps()
    expect(
      (await inspectSkillCompatibility(policy, "/task/worktree", ["oma-debug"], [route], injected)).routes[0]?.status,
    ).toBe("pass")
    expect(injected.plan).toHaveBeenCalledWith("/task/worktree", ["oma-debug"], undefined)
    expect(injected.cliVersion).toHaveBeenCalledWith("claude", undefined)
  })

  it.each([
    [
      "synthetic",
      (value: ReturnType<typeof report>) => {
        value.sourceKind = "synthetic"
      },
    ],
    [
      "native delivery",
      (value: ReturnType<typeof report>) => {
        value.delivery = "native"
      },
    ],
    [
      "fixture scope",
      (value: ReturnType<typeof report>) => {
        value.auditScope = "fixture-contract"
      },
    ],
    [
      "plan",
      (value: ReturnType<typeof report>) => {
        value.mode = "plan"
        value.status = "planned"
      },
    ],
    [
      "interruption",
      (value: ReturnType<typeof report>) => {
        value.status = "interrupted"
      },
    ],
    [
      "stale",
      (value: ReturnType<typeof report>) => {
        value.createdAt = "2026-01-01T00:00:00Z"
      },
    ],
    [
      "future",
      (value: ReturnType<typeof report>) => {
        value.createdAt = "2027-01-01T00:00:00Z"
      },
    ],
    [
      "architecture",
      (value: ReturnType<typeof report>) => {
        value.host.arch = "x64"
      },
    ],
    [
      "OMA version",
      (value: ReturnType<typeof report>) => {
        value.omaVersion = "15.0.0"
      },
    ],
    [
      "CLI version",
      (value: ReturnType<typeof report>) => {
        first(value.cells).cliVersion = "1.0.0"
      },
    ],
    [
      "missing case",
      (value: ReturnType<typeof report>) => {
        value.cases = []
      },
    ],
    [
      "missing cell",
      (value: ReturnType<typeof report>) => {
        value.cells = []
      },
    ],
    [
      "content",
      (value: ReturnType<typeof report>) => {
        first(value.bundle.skills).hash = "b".repeat(64)
      },
    ],
    [
      "coverage",
      (value: ReturnType<typeof report>) => {
        first(value.bundle.skills).requiredFiles.push("extra.md")
      },
    ],
    [
      "cell hash",
      (value: ReturnType<typeof report>) => {
        first(value.cells).contentHash = "b".repeat(64)
      },
    ],
    [
      "unverifiable",
      (value: ReturnType<typeof report>) => {
        first(value.cells).status = "unverifiable"
      },
    ],
    [
      "failed check",
      (value: ReturnType<typeof report>) => {
        first(first(value.cells).checks).status = "fail"
      },
    ],
    [
      "missing mandatory check",
      (value: ReturnType<typeof report>) => {
        first(value.cells).checks = first(value.cells).checks.filter((check) => check.id !== "integrity")
      },
    ],
    [
      "missing reference check",
      (value: ReturnType<typeof report>) => {
        first(value.cells).checks = first(value.cells).checks.filter(
          (check) => check.id !== "reference:../_shared/core/policy.md",
        )
      },
    ],
    [
      "canary proof",
      (value: ReturnType<typeof report>) => {
        const content = first(value.cells).checks.find((check) => check.id === "content")
        if (!content) throw new Error("Fixture content check is missing")
        content.proof = "canary"
      },
    ],
  ])("does not authorize %s evidence", async (_name, mutate) => {
    const saved = report()
    mutate(saved)
    expect((await inspect(saved))?.status).toBe("unknown")
  })

  it("keeps failed and unknown audits distinct", async () => {
    const saved = report()
    first(saved.cells).status = "fail"
    expect((await inspect(saved))?.status).toBe("fail")
  })

  it("does not treat default, requested-only, or unavailable models as a match", async () => {
    expect((await inspect(report(), report(), { actorType: "claude", model: "" }))?.status).toBe("unknown")
    expect((await inspect(report(), report(), { actorType: "claude", model: "requested-alias" }))?.status).toBe(
      "unknown",
    )
    const saved = report()
    Object.assign(first(saved.cells), { model: null })
    expect((await inspect(saved))?.status).toBe("unknown")
    expect((await inspect(report(), report(), { actorType: "cursor", model: "measured-model" }))?.status).toBe(
      "unknown",
    )
  })

  it("allows a report superset while matching every selected skill and its coverage", async () => {
    const saved = report()
    saved.bundle.hash = "b".repeat(64)
    saved.bundle.skills.push({ ...first(saved.bundle.skills), name: "oma-qa", caseId: "read-oma-qa" })
    expect((await inspect(saved))?.status).toBe("pass")
  })

  it.each(["missing", "excluded"])("rejects %s references even when old and current manifests agree", async (kind) => {
    const saved = report()
    if (kind === "missing") first(saved.bundle.skills).missingFiles.push("missing.md")
    else first(saved.bundle.skills).excludedReferences.push({ path: "../unsafe.md", reason: "outside tree" })
    expect((await inspect(saved, saved))?.status).toBe("unknown")
  })

  it("rejects duplicate vendor cells, case IDs and skill names", () => {
    const saved = report()
    saved.cells.push(first(saved.cells))
    expect(() => parseSkillMatrix(saved)).toThrow("repeats")
    const duplicateCase = report()
    duplicateCase.cases.push(first(duplicateCase.cases))
    expect(() => parseSkillMatrix(duplicateCase)).toThrow("repeats")
    const duplicateSkill = report()
    duplicateSkill.bundle.skills.push(first(duplicateSkill.bundle.skills))
    expect(() => parseSkillMatrix(duplicateSkill)).toThrow("repeats")
    const duplicateCheck = report()
    first(duplicateCheck.cells).checks.push(first(first(duplicateCheck.cells).checks))
    expect(() => parseSkillMatrix(duplicateCheck)).toThrow("repeats")
  })

  it("revalidates content on every dispatch and preserves cancellation", async () => {
    const injected = deps()
    const current = report()
    injected.plan = vi.fn(async () => ({ ...current, mode: "plan", status: "planned", cells: [] }))
    expect(
      (await inspectSkillCompatibility(policy, "/worktree", ["oma-debug"], [route], injected)).routes[0]?.status,
    ).toBe("pass")
    first(current.bundle.skills).hash = "b".repeat(64)
    expect(
      (await inspectSkillCompatibility(policy, "/worktree", ["oma-debug"], [route], injected)).routes[0]?.status,
    ).toBe("unknown")
    await expect(
      inspectSkillCompatibility(policy, "/worktree", ["oma-debug"], [route], injected, AbortSignal.abort()),
    ).rejects.toThrow("interrupted")
  })

  it("does not inspect unconfigured skills or expose report errors", async () => {
    const injected = deps()
    expect((await inspectSkillCompatibility(policy, "/worktree", [], [route], injected)).routes[0]?.status).toBe("pass")
    expect(injected.readReport).not.toHaveBeenCalled()
    injected.readReport = vi.fn(async () => {
      throw new Error("SECRET_CREDENTIAL")
    })
    expect(
      (await inspectSkillCompatibility(policy, "/worktree", ["oma-debug"], [route], injected)).routes[0]?.reason,
    ).not.toContain("SECRET")
  })
})
