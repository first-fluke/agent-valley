/**
 * Next.js Instrumentation — bootstraps the Symphony Orchestrator.
 *
 * All Node.js-only code lives in src/lib/bootstrap.ts, dynamically imported
 * to prevent Edge Runtime static analysis warnings.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  try {
    const { bootstrap } = await import("@/lib/bootstrap")
    await bootstrap()
  } catch (err) {
    console.error("[instrumentation] Failed to initialize Orchestrator:", err)
    console.error("[instrumentation] Dashboard will run without orchestrator (UI-only mode)")
  }
}
