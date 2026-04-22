import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, defineProject } from "vitest/config"

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: false,
    projects: [
      defineProject({
        resolve: {
          alias: {
            "@": resolve(root, "packages/core/src"),
          },
        },
        test: {
          name: "core",
          include: ["packages/core/src/**/*.test.ts"],
        },
      }),
      defineProject({
        resolve: {
          alias: {
            "@": resolve(root, "apps/cli/src"),
          },
        },
        test: {
          name: "cli",
          include: ["apps/cli/src/**/*.test.ts"],
        },
      }),
      defineProject({
        resolve: {
          alias: {
            "@": resolve(root, "apps/dashboard/src"),
          },
        },
        test: {
          name: "dashboard",
          include: ["apps/dashboard/src/**/*.test.ts"],
        },
      }),
    ],
    // ── Coverage (v0.2 § 5.6 / § 7 merge gate) ────────────────────────────────
    //
    // include/exclude scope rationale:
    //   - Only hand-written backend + CLI source is measured. Dashboard UI
    //     (React components / app router files) is out-of-scope because the
    //     project has no browser test infrastructure in v0.2 — bringing those
    //     files in would drop overall coverage below any meaningful gate.
    //   - Test files, characterization suites, contract helpers, and fakes are
    //     excluded: they execute every line by definition, so including them
    //     inflates the number rather than measuring production code.
    //   - Types-only files (`*.d.ts`, pure re-export `index.ts`) are excluded
    //     so they do not pollute branch/function denominators.
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      include: ["packages/core/src/**/*.ts", "apps/cli/src/**/*.ts"],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.d.ts",
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        // Contract helpers + fakes are test infrastructure, not production code.
        "packages/core/src/__tests__/**",
        // Barrel/index re-exports contribute no logic but 0% function coverage.
        "**/index.ts",
        // Domain port files are pure TypeScript interfaces / type aliases with
        // no runtime statements — v8 still reports 0% coverage on them.
        "packages/core/src/domain/ports/**",
        "packages/core/src/domain/parsed-webhook-event.ts",
        "packages/core/src/domain/ledger.ts",
        "packages/core/src/sessions/agent-session.ts",
        // Supabase relay bridge — external-service integration exercised only
        // in the dashboard runtime, no unit-test seam in v0.2. Tracked for
        // v0.3 coverage uplift (see CHANGELOG Unreleased).
        "packages/core/src/relay/ledger-bridge.ts",
        "packages/core/src/relay/node-id.ts",
        "packages/core/src/relay/supabase-ledger-client.ts",
        // Scoring service is an LLM-call boundary wrapper; covered indirectly
        // via routing integration (score-routing.test.ts). Dedicated seam
        // planned for v0.3.
        "packages/core/src/orchestrator/scoring-service.ts",
        // Interactive CLI entry points (prompt loops, OAuth, live dashboard,
        // subprocess-driven issue expansion). No unit-test infrastructure in
        // v0.2 — exercised manually + e2e. The pure helpers under
        // `apps/cli/src/setup/` (mask, preview, resolve, save, yaml-build,
        // github-api, linear-api) stay covered.
        "apps/cli/src/login.ts",
        "apps/cli/src/supervisor.ts",
        "apps/cli/src/issue.ts",
        "apps/cli/src/breakdown.ts",
        "apps/cli/src/invite.ts",
        "apps/cli/src/setup/agent-step.ts",
        "apps/cli/src/setup/edit.ts",
        "apps/cli/src/setup/fast-track.ts",
        "apps/cli/src/setup/github-step.ts",
        "apps/cli/src/setup/linear-step.ts",
        "apps/cli/src/setup/parallel-step.ts",
        "apps/cli/src/setup/tracker-step.ts",
        "apps/cli/src/setup/tunnel-step.ts",
        "apps/cli/src/setup/ui.ts",
        "apps/cli/src/setup/workspace-step.ts",
        "apps/cli/src/setup/types.ts",
        // Dashboard UI is out of scope for the v0.2 coverage gate (no browser
        // test runtime). It is already excluded via `include` but listed here
        // for explicitness.
        "apps/dashboard/**",
      ],
      // Thresholds are enforced on the aggregate global numbers. Per-file
      // thresholds are intentionally not set in v0.2 — they would block
      // unrelated PRs touching legacy high-complexity files.
      thresholds: {
        lines: 80,
        branches: 70,
        functions: 80,
        statements: 80,
      },
    },
  },
})
