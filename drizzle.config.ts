import { defineConfig } from "drizzle-kit"

// Generation needs no database credentials. `av team migrate` resolves the configured target.
export default defineConfig({
  dialect: "turso",
  schema: "./packages/core/src/relay/turso-schema.ts",
  out: "./turso/migrations",
})
