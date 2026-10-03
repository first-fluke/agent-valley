import { latestWorkRun } from "./routing"
import type { ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

function addReviewer(mission: Mission, vendor: string): Persona {
  if (mission.personas.length >= 20)
    throw new Error(
      "Independent vendor review needs a roster slot. Add a reviewer using the required ready vendor or leave a slot free in the --actors roster.",
    )
  let id = `review-${vendor}`
  while (mission.personas.some((actor) => actor.id === id)) id += "-r"
  const reviewer: Persona = {
    id,
    name: `Independent ${vendor} reviewer`,
    role: "Independently inspect actual files and task acceptance evidence; report blockers without editing files.",
    agentType: vendor,
    skills: [],
  }
  mission.personas.push(reviewer)
  return reviewer
}

export function selectTaskReviewer(mission: Mission, task: ChiefTask, state: ChiefTaskState): Persona {
  const configured = mission.personas.find((actor) => actor.id === state.reviewerId)
  if (!configured) throw new Error("Restore the configured task reviewer before resuming.")
  const policy = mission.operatingPolicy
  if (!policy || policy.reviewVendor === "off") return configured
  const run = latestWorkRun(mission, task.id)
  const worker = run?.actorType ?? mission.personas.find((actor) => actor.id === task.personaId)?.agentType
  if (!worker) throw new Error("Restore this task's actual work Actor before reviewing it.")
  const ready = policy.readyActors ?? mission.availableAgents ?? []
  const otherVendor = ready.find((vendor) => vendor !== worker)
  let reviewer = configured
  let reason = "Only one ready vendor; independent Actor review used the same vendor."
  if (otherVendor) {
    reviewer =
      mission.personas.find(
        (actor) => actor.id !== task.personaId && actor.agentType !== worker && ready.includes(actor.agentType),
      ) ?? configured
    if (reviewer.agentType === worker || !ready.includes(reviewer.agentType)) {
      reviewer = addReviewer(mission, otherVendor)
    }
    reason = "Independent review uses a different ready vendor from the actual work run."
  } else if (policy.reviewVendor === "require") {
    throw new Error(
      `Cross-vendor review is required but no ready vendor differs from ${worker}. Install/login another Actor CLI and start a new mission, or set chief.review_vendor to prefer before creating an order.`,
    )
  } else if (configured.agentType !== worker && ready.includes(worker)) {
    reviewer =
      mission.personas.find((actor) => actor.id !== task.personaId && actor.agentType === worker) ??
      addReviewer(mission, worker)
  } else if (!ready.length) {
    reason =
      "No vendor readiness pool is recorded; the configured independent Actor is attempted with readiness unknown."
  }
  state.reviewerId = reviewer.id
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  mission.operations.reviewDecisions.push({
    taskId: task.id,
    ...(run ? { runId: run.runId } : {}),
    workerActorType: worker,
    reviewerId: reviewer.id,
    reviewerActorType: reviewer.agentType,
    crossVendor: reviewer.agentType !== worker,
    outcome: "assigned",
    reason,
  })
  return reviewer
}
