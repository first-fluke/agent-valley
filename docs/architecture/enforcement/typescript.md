# TypeScript Architecture Enforcement — dependency-cruiser

> Automatically checks layer dependency direction rules (`docs/architecture/LAYERS.md`) in CI and pre-commit hooks.
>
> **This repository** uses the dependency-free `scripts/check-import-rules.mjs`
> (`bun run check:imports`) instead of installing dependency-cruiser. It
> enforces domain purity, adapter isolation, and acyclic imports. Domain files
> cannot import external packages; LangChain imports are confined to
> `chief/coordinator-graph.ts`, which routes stages while AV owns Mission state.
> Existing
> violations are frozen in `scripts/import-rules.baseline.json`; any new
> violation fails CI. The configuration below documents the equivalent rules.

---

## Installation

```bash
npm install --save-dev dependency-cruiser
```

---

## .dependency-cruiser.cjs Configuration Example

Create `.dependency-cruiser.cjs` in the project root.

```js
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-domain-to-infrastructure",
      comment: "Domain layer must not import from Infrastructure. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/infrastructure" },
    },
    {
      name: "no-domain-to-application",
      comment: "Domain layer must not import from Application. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/application" },
    },
    {
      name: "no-domain-to-presentation",
      comment: "Domain layer must not import from Presentation. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/domain" },
      to: { path: "^src/presentation" },
    },
    {
      name: "no-infrastructure-to-application",
      comment: "Infrastructure layer must not import from Application. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/application" },
    },
    {
      name: "no-infrastructure-to-presentation",
      comment: "Infrastructure layer must not import from Presentation. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/presentation" },
    },
    {
      name: "no-application-to-presentation",
      comment: "Application layer must not import from Presentation. See LAYERS.md.",
      severity: "error",
      from: { path: "^src/application" },
      to: { path: "^src/presentation" },
    },
  ],
  options: {
    doNotFollow: {
      path: "node_modules",
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: "tsconfig.json",
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
}
```

---

## CI Execution Command

```bash
npx depcruise --config .dependency-cruiser.cjs src
```

Returns exit code 1 on violation, causing CI to fail automatically.

Example addition to `scripts/harness/validate.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "==> Checking architecture layer constraints..."
npx depcruise --config .dependency-cruiser.cjs src

echo "==> Architecture check passed."
```

---

## pre-commit Hook Integration

Add to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: local
    hooks:
      - id: dependency-cruiser
        name: Dependency Cruiser (architecture layers)
        language: node
        entry: npx depcruise --config .dependency-cruiser.cjs src
        pass_filenames: false
        types: [typescript]
```

Or integrate with `lint-staged` in `package.json`:

```json
{
  "lint-staged": {
    "src/**/*.ts": ["npx depcruise --config .dependency-cruiser.cjs"]
  }
}
```

---

## Example Output on Rule Violation

```
error no-domain-to-infrastructure: src/domain/issue.ts -> src/infrastructure/linearApiClient.ts

  Domain layer must not import from Infrastructure. See LAYERS.md.
  Fix: Define only interfaces in Domain, and place LinearApiClient in infrastructure/.
```
