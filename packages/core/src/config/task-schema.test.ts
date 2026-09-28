import { describe, expect, test } from "vitest"
import { projectConfigSchema } from "./yaml-loader"

describe("task configuration", () => {
  test("defaults to code when task is omitted", () => {
    expect(projectConfigSchema.parse({}).task).toBeUndefined()
  })

  test("accepts explicit analysis with a current-attempt report template", () => {
    expect(
      projectConfigSchema.parse({
        task: { kind: "analysis", report_path: "reports/{{attempt.id}}.md" },
        routing: {
          rules: [
            {
              label: "analysis",
              workspace_root: "/repo",
              task: { kind: "analysis", report_path: "notes/{{attempt.id}}.md" },
            },
          ],
        },
      }).task?.kind,
    ).toBe("analysis")
  })

  test.each([
    "reports/result.md",
    "/outside/{{attempt.id}}.md",
    "../escape/{{attempt.id}}.md",
  ])("rejects an unbound report path: %s", (report_path) => {
    expect(projectConfigSchema.safeParse({ task: { kind: "analysis", report_path } }).success).toBe(false)
  })
})
