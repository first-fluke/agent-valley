import { availableActorRoutes } from "./actor-availability"
import { actorRouteHealth } from "./actor-health"
import { MissionPause } from "./execution"
import { unavailableProviders } from "./handoff-contract"
import { latestWorkRun } from "./routing"
import type { ChiefTask, ChiefTaskState, Mission, Persona } from "./types"

function addReviewer(mission: Mission, vendor: string, model?: string): Persona {
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
    ...(model ? { model } : {}),
    skills: [],
  }
  mission.personas.push(reviewer)
  return reviewer
}

export function selectTaskReviewer(mission: Mission, task: ChiefTask, state: ChiefTaskState, gateId?: string): Persona {
  const configured = mission.personas.find((actor) => actor.id === state.reviewerId)
  if (!configured) throw new Error("Restore the configured task reviewer before resuming.")
  const policy = mission.operatingPolicy
  if (!policy || policy.reviewVendor === "off") {
    availableActorRoutes(mission, [{ actorType: configured.agentType, model: configured.model }])
    return configured
  }
  const run = latestWorkRun(mission, task.id)
  const worker = run?.actorType ?? mission.personas.find((actor) => actor.id === task.personaId)?.agentType
  if (!worker) throw new Error("Restore this task's actual work Actor before reviewing it.")
  const blocked = unavailableProviders(mission.handoff)
  const recordedReady = policy.readyActors ?? mission.availableAgents ?? []
  const ready = recordedReady.filter((vendor) => !blocked.has(vendor))
  if (recordedReady.length && !ready.length)
    throw new MissionPause(
      "No recorded ready reviewer remains after saved provider availability exclusions. Restore access to an eligible Actor before continuing; the completed work remains pending review.",
      "handoff-unavailable",
    )
  const pool = [configured, ...mission.personas.filter((actor) => actor.id !== configured.id)]
    .filter((actor) => actor.id !== task.personaId && ready.includes(actor.agentType))
    .map((actor) => ({ actorType: actor.agentType, model: actor.model, actor: actor as Persona | undefined }))
  for (const vendor of ready)
    if (!pool.some((entry) => entry.actorType === vendor)) {
      const model = mission.operatingPolicy?.routing?.candidates.find((entry) => entry.actorType === vendor)?.model
      pool.push({ actorType: vendor, model, actor: undefined })
    }
  const crossVendor = pool.filter((entry) => entry.actorType !== worker)
  if (!crossVendor.length && policy.reviewVendor === "require") {
    throw new Error(
      `Cross-vendor review is required but no ready vendor differs from ${worker}. Install/login another Actor CLI and start a new mission, or set chief.review_vendor to prefer before creating an order.`,
    )
  }
  const healthyCrossVendor = crossVendor.filter((entry) => actorRouteHealth(mission, entry).state === "ready")
  const candidates = policy.reviewVendor === "require" ? crossVendor : healthyCrossVendor.length ? crossVendor : pool
  const selected = availableActorRoutes(mission, candidates).at(0)
  const reviewer = selected?.actor ?? (selected ? addReviewer(mission, selected.actorType, selected.model) : configured)
  if (!selected) availableActorRoutes(mission, [{ actorType: reviewer.agentType, model: reviewer.model }])
  const reason = !ready.length
    ? "No vendor readiness pool is recorded; the configured independent Actor is attempted with readiness unknown."
    : reviewer.agentType !== worker
      ? "Independent review uses a different healthy ready vendor from the actual work run."
      : "Cross-vendor review is preferred, but other vendors are unavailable or cooling down; an independent Actor uses the same healthy vendor."
  state.reviewerId = reviewer.id
  mission.operations ??= { runs: [], routingEvidence: [], reviewDecisions: [] }
  mission.operations.reviewDecisions.push({
    taskId: task.id,
    ...(gateId ? { gateId } : {}),
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
