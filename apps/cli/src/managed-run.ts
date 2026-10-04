export function assertNotManagedRun(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AGENT_VALLEY_MANAGED_RUN === "1")
    throw new Error(
      "This Actor is already managed by AV. Complete the assigned task directly; do not start or resume another AV mission.",
    )
}
