# TypeScript Getting Started Guide

> Reference this file when starting a Symphony implementation with the TypeScript stack.
> For layer principles see `docs/architecture/LAYERS.md`, for forbidden patterns see `docs/architecture/CONSTRAINTS.md`.

---

## Recommended Stack

| Role | Choice |
|---|---|
| Runtime | Node.js 26.10.0 |
| Language | TypeScript 7+ |
| HTTP Server | Express or Hono |
| ORM | Prisma |
| Schema Validation | Zod |
| Testing | Jest + ts-jest |
| Architecture Linter | dependency-cruiser |
| Code Linter | ESLint + Prettier |

---

## Project Initialization

```bash
# 1. Create project directory
mkdir my-symphony && cd my-symphony

# 2. Initialize npm
npm init -y

# 3. Install TypeScript
npm install --save-dev typescript ts-node @types/node

# 4. Generate TypeScript config
npx tsc --init

# 5. Install core dependencies
npm install express zod dotenv
npm install --save-dev @types/express

# 6. Testing tools
npm install --save-dev jest ts-jest @types/jest

# 7. Linters
npm install --save-dev eslint prettier @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-config-prettier

# 8. Architecture linter
npm install --save-dev dependency-cruiser
```

---

## Directory Structure

Directly reflects the layers defined in `docs/architecture/LAYERS.md`.

```
src/
├── domain/
│   ├── issue.ts              ← Issue domain model
│   ├── workspace.ts          ← Workspace domain model
│   ├── runAttempt.ts         ← RunAttempt domain model
│   └── ports/
│       ├── issueTrackerPort.ts  ← External system interface (implemented by Infrastructure)
│       └── workspacePort.ts
├── application/
│   ├── orchestrator/
│   │   ├── webhookHandler.ts
│   │   ├── stateMachine.ts
│   │   ├── retryQueue.ts
│   │   └── index.ts
│   └── workspaceManager.ts
├── infrastructure/
│   ├── linearApiClient.ts    ← issueTrackerPort implementation
│   ├── fileSystem.ts
│   ├── git.ts
│   └── logger.ts
├── presentation/
│   ├── router.ts
│   └── cli.ts
└── index.ts                  ← Entry point: DI assembly + server start
```

---

## tsconfig.json Key Settings

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": {
      "@domain/*": ["src/domain/*"],
      "@application/*": ["src/application/*"],
      "@infrastructure/*": ["src/infrastructure/*"],
      "@presentation/*": ["src/presentation/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

`strict: true` is mandatory. It enforces type safety for agent-generated code.

---

## Environment Variable Loading — dotenv + Zod Type Validation

```typescript
// src/infrastructure/config.ts
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  LINEAR_API_KEY: z.string().min(1, {
    message:
      "LINEAR_API_KEY is not set. Add it to .env (see .env.example).\n" +
      "  Format: LINEAR_API_KEY=lin_api_xxxxxxxx",
  }),
  LINEAR_TEAM_ID: z.string().min(1, {
    message:
      "LINEAR_TEAM_ID is not set. Add it to .env.\n" +
      "  Find it in Linear: Settings → Members → Team",
  }),
  WORKSPACE_ROOT: z
    .string()
    .min(1)
    .refine((v) => v.startsWith("/"), {
      message:
        "WORKSPACE_ROOT must be an absolute path.\n" +
        "  Fix: Set WORKSPACE_ROOT=/absolute/path in .env",
    }),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Configuration error:\n");
  parsed.error.issues.forEach((issue) => {
    console.error(`  ${issue.path.join(".")}: ${issue.message}\n`);
  });
  process.exit(1);
}

export const config = parsed.data;
```

---

## Linter Configuration

### ESLint — eslint.config.mjs

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/explicit-function-return-type": "warn",
      "no-console": ["warn", { allow: ["error"] }],
    },
  }
);
```

### Prettier — .prettierrc

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

### package.json scripts

```json
{
  "scripts": {
    "build": "tsc",
    "lint": "eslint src/",
    "format": "prettier --write src/",
    "format:check": "prettier --check src/",
    "test": "jest",
    "validate": "npm run lint && npx depcruise --config .dependency-cruiser.cjs src"
  }
}
```

---

## Architecture Linter Integration

Refer to `docs/architecture/enforcement/typescript.md` to configure `.dependency-cruiser.cjs`.
