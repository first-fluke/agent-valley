import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, defineProject } from "vitest/config"

const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    globals: false,
    // Git/process integration suites spawn several children per worker.
    // CPU-count fanout exhausts process/IO capacity on large developer hosts.
    maxWorkers: 4,
    // Local iteration tolerates the known worktree-teardown race; CI must not:
    // a retried pass hides a real failure and masks the isolation defect.
    retry: process.env.CI ? 0 : 2,
    // Git worktree suites run real `git` commands; 5s is too tight under a
    // coverage-instrumented full run on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    projects: [
      defineProject({
        test: { name: "scripts", include: ["scripts/**/*.test.ts"] },
      }),
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
          include: ["apps/dashboard/src/**/*.test.{ts,tsx}"],
          environment: "jsdom",
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
      include: [
        "packages/core/src/**/*.ts",
        "apps/cli/src/**/*.ts",
        // Dashboard server-side surface (auth, relay, webhooks, SSE) is
        // testable without a browser and is part of the shipped product.
        "apps/dashboard/src/lib/**/*.ts",
        "apps/dashboard/src/app/api/**/route.ts",
      ],
      exclude: [
        "**/__tests__/**",
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        // Contract helpers + fakes are test infrastructure, not production code.
        "packages/core/src/__tests__/**",
        // Domain port files are pure TypeScript interfaces / type aliases with
        // no runtime statements — v8 still reports 0% coverage on them.
        "packages/core/src/domain/ports/**",
        "packages/core/src/domain/parsed-webhook-event.ts",
        "packages/core/src/domain/ledger.ts",
        "packages/core/src/sessions/agent-session.ts",
        // Scoring service is an LLM-call boundary wrapper; covered indirectly
        // via routing integration (score-routing.test.ts). Dedicated seam
        // planned for v0.3.
        "packages/core/src/orchestrator/scoring-service.ts",
        // Interactive CLI entry points (prompt loops, OAuth, live dashboard,
        // subprocess-driven issue expansion). No unit-test infrastructure in
        // v0.2 — exercised manually + e2e. The pure helpers under
        // `apps/cli/src/setup/` (mask, preview, resolve, save, yaml-build,
        // github-api, linear-api) stay covered.
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
        // Canvas/WebGL renderer is visual code driven by PixiJS; it has no
        // meaningful statement-level assertions and is covered by the
        // dashboard build + office-layout tests.
        "apps/dashboard/src/lib/canvas/**",
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
