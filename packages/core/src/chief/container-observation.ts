import {
  containerObservationFailure,
  containerResultFingerprint,
  createContainerCommandRunner,
} from "./container-observation-adapter"
import { type ContainerCommandExecutor, executeContainerCommand } from "./container-observation-command"
import { observeDockerContainer } from "./container-observation-docker"
import { observeKubernetesContainer } from "./container-observation-kubernetes"
import {
  type ContainerObservationPolicy,
  type ContainerObservationSnapshot,
  containerObservationPolicySchema,
  containerObservationSnapshotSchema,
} from "./container-observation-policy"
import { validateContainerObservation } from "./container-observation-state"
import { containerDigest } from "./container-observation-text"

export interface ContainerObservationDependencies {
  now?: () => Date
  signal?: AbortSignal
  execute?: ContainerCommandExecutor
  env?: Readonly<Record<string, string | undefined>>
}

export async function collectContainerObservation(
  input: ContainerObservationPolicy,
  previous?: ContainerObservationSnapshot,
  dependencies: ContainerObservationDependencies = {},
): Promise<ContainerObservationSnapshot> {
  const parsed = containerObservationPolicySchema.safeParse(input)
  if (!parsed.success)
    throw new Error(
      `Invalid chief.container_observation.${parsed.error.issues[0]?.path.join(".") ?? "targets"}. Fix this key in av.yaml.`,
    )
  const policy = parsed.data
  if (previous) validateContainerObservation(policy, previous)
  const now = (dependencies.now ?? (() => new Date()))()
  const env = dependencies.env ?? process.env
  const execute = dependencies.execute ?? executeContainerCommand
  const results: ContainerObservationSnapshot["results"] = []
  if (policy.enabled) {
    for (const target of policy.targets) {
      const ctx = {
        target,
        policy,
        env,
        now: dependencies.now ?? (() => new Date()),
        previous: previous?.results.find((result) => result.targetId === target.id),
        run: createContainerCommandRunner(target, policy, execute, dependencies.signal),
      }
      try {
        const result = await (target.kind === "docker" ? observeDockerContainer(ctx) : observeKubernetesContainer(ctx))
        results.push({ ...result, fingerprint: containerResultFingerprint(result) })
      } catch (error) {
        const result = {
          targetId: target.id,
          kind: target.kind,
          status: "unavailable" as const,
          reason: containerObservationFailure(error),
          issues: [],
        }
        results.push({ ...result, fingerprint: containerResultFingerprint(result) })
      }
    }
  }
  return containerObservationSnapshotSchema.parse({
    collectedAt: now.toISOString(),
    nextPollAt: new Date(
      Math.max(now.getTime(), (dependencies.now ?? (() => new Date()))().getTime()) + policy.poll_interval_sec * 1_000,
    ).toISOString(),
    fingerprint: containerDigest(results.map((result) => [result.targetId, result.kind, result.fingerprint])),
    results,
  })
}
