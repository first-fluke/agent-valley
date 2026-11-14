import type { Mission } from "./types"

const sharedOwnershipGuidance =
  "Preserve other Actors' work and respect assigned file ownership. Shared manifests, lockfiles and registries have one assigned writer per execution wave; any ownership handoff requires an actual artifact dependency. Report needed changes outside the assignment to the Chief for coordination."

export function taskDecompositionGuidance(mission: Mission, phase: "plan" | "work" | "replan"): string {
  if (phase === "work")
    return [
      "Implement the saved assignment using its owned files, required inputs, promised outputs, established interfaces and dependency deliverables. Do not modify saved task instructions, acceptance criteria, the mission graph or Actor assignments. Report ownership or interface conflicts to the Chief with exact paths and evidence. Report changed paths, produced artifacts, interface compatibility and concrete check evidence to the Chief.",
      sharedOwnershipGuidance,
    ].join("\n")
  const limit = mission.executionPolicy?.maxParallel ?? 1
  return [
    `For substantial work spanning real modules, services, domains or layers, divide tasks by independently owned deliverables when this improves execution. The saved workspace concurrency limit is ${limit}; plan within it. Keep a small coherent request as one task and keep genuinely coupled changes together. Do not invent work to fill parallel slots.`,
    ...(limit > 1
      ? [
          `Up to ${limit} ready tasks run at once, and a wave with one ready task leaves the other slots idle for its whole duration. When the work is substantial, shape the plan so several tasks are ready together: split implementation by disjoint owned paths (package, module, surface) rather than by layer, role or step, and keep each unit's tests in the task that implements that unit instead of a later test-only task.`,
        ]
      : []),
    "Reuse existing stable interfaces. If independent consumers need a missing or changing contract, assign a concise contract-producing task first to establish the shared types, API, protocol or artifact and its acceptance evidence. Consumers may then depend on that contract without waiting for unrelated implementation work.",
    "Document each task's boundaries in its existing instructions and acceptance: owned files, required input artifacts, output artifacts and interface expectations. Assign the writer for shared files. Record these details only in existing Task instructions/acceptance; do not introduce Task or response-root schema keys.",
    sharedOwnershipGuidance,
    "An independent verification or QA task delivers evidence: its acceptance is the accuracy, completeness and reproducibility of its report and receipts, never the absence of defects in another task's deliverable. A reproducible defect it finds is reported as a blocker for the owning implementation task; repairing the QA task cannot fix product code, so do not phrase QA acceptance as the blocker being cleared.",
    "A dependency means the task needs an actual preceding deliverable; name that delivered file or interface in the dependent task's instructions. Do not chain tasks merely because of layer names, team roles or plan order, and do not remove a genuine dependency to force concurrency. Independent consumers of the same stable contract can share that prerequisite. Add an integration task only when real wiring or combined acceptance checks are needed, depending on the relevant implementations; retain the framework's independent task reviews and final verification.",
    ...(phase === "replan"
      ? [
          "During recovery, reuse verified deliverables and retained interfaces. Repartition only the remaining work when it helps the original outcome; preserve every original acceptance obligation, the existing roster, Chief identity and spent budgets.",
        ]
      : []),
  ].join("\n")
}
