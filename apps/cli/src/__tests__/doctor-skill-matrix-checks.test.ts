import { projectConfigSchema } from "@agent-valley/core/config/yaml-loader"
import type { SkillMatrixDeps } from "@agent-valley/core/oma/skill-matrix-adapter"
import { describe, expect, it, vi } from "vitest"
import type { DoctorDeps } from "../doctor-checks"
import { computeExitCode } from "../doctor-config-checks"
import { checkSkillMatrix } from "../doctor-skill-matrix-checks"

function deps(skillMatrix: SkillMatrixDeps): DoctorDeps {
  return {
    cwd: "/project",
    home: "/home",
    platform: "darwin",
    env: {},
    existsSync: () => false,
    readFileSync: () => "",
    resolveBinary: () => null,
    isSandboxExecAvailable: async () => true,
    isBwrapAvailable: async () => false,
    resolveGlobalConfigPath: () => "/settings.yaml",
    loadGlobalConfig: () => null,
    loadProjectConfig: () => null,
    skillMatrix,
  }
}
function unavailable(): SkillMatrixDeps {
  return {
    now: Date.now,
    platform: "darwin",
    arch: "arm64",
    readReport: vi.fn(async () => {
      throw new Error("SECRET")
    }),
    plan: vi.fn(),
    cliVersion: vi.fn(),
  }
}

describe("doctor cached skill matrix checks", () => {
  it("leaves unconfigured projects unchanged without probing tools", async () => {
    const injected = unavailable()
    expect(await checkSkillMatrix(null, null, deps(injected))).toEqual([])
    expect(injected.readReport).not.toHaveBeenCalled()
  })

  it.each(["warn", "require"] as const)("shows unknown evidence in %s mode without live model calls", async (mode) => {
    const injected = unavailable()
    const project = projectConfigSchema.parse({
      workspace: { root: "/target" },
      actor: { type: "codex", model: "explicit-model" },
      oma: { skill_compatibility: { report_path: "reports/matrix.json", mode } },
    })
    const results = await checkSkillMatrix(project, null, deps(injected))
    expect(injected.readReport).toHaveBeenCalledWith("/project/reports/matrix.json")
    expect(injected.plan).not.toHaveBeenCalled()
    expect(injected.cliVersion).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ id: "oma.skill-compatibility", status: "unknown", critical: mode === "require" })
    expect(results[0]?.message).toContain("codex/explicit-model")
    expect(results[0]?.message).not.toContain("SECRET")
    expect(computeExitCode(results)).toBe(mode === "require" ? 1 : 0)
  })

  it("validates the nested configuration path and supplies the documented age default", () => {
    const project = projectConfigSchema.parse({
      oma: { skill_compatibility: { report_path: "matrix.json", mode: "warn" } },
    })
    expect(project.oma?.skill_compatibility?.max_age_hours).toBe(168)
    expect(project.oma?.mode).toBe("off")
    const invalid = projectConfigSchema.safeParse({ oma: { skill_compatibility: { mode: "require" } } })
    expect(invalid.success).toBe(false)
    if (!invalid.success) expect(invalid.error.issues[0]?.path).toEqual(["oma", "skill_compatibility", "report_path"])
  })
})
