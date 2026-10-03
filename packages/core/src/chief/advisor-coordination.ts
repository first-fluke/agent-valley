import { designPlanKey, designReviewPrompt } from "./design-lead"
import { marketingPlanKey, marketingReviewPrompt } from "./marketing-lead"
import { parseReview } from "./schemas"
import { technicalPlanKey, technicalReviewPrompt } from "./technical-lead"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"

export async function consultDirectors(
  mission: Mission,
  ports: ChiefPorts,
  hooks: {
    run(actor: Persona, prompt: string, stage: ChiefStage): Promise<string>
    save(stage: string, message: string): Promise<void>
  },
): Promise<void> {
  const entries = [
    {
      id: mission.technicalLeadId,
      field: "technicalReview" as const,
      stage: "technical-review" as const,
      key: technicalPlanKey,
      prompt: technicalReviewPrompt,
    },
    {
      id: mission.designLeadId,
      field: "designReview" as const,
      stage: "design-review" as const,
      key: designPlanKey,
      prompt: designReviewPrompt,
    },
    {
      id: mission.marketingLeadId,
      field: "marketingReview" as const,
      stage: "marketing-review" as const,
      key: marketingPlanKey,
      prompt: marketingReviewPrompt,
    },
  ].filter((entry) => entry.id)
  const consult = async (entry: (typeof entries)[number]) => {
    const actor = mission.personas.find((actor) => actor.id === entry.id)
    if (!actor) throw new Error("Restore the nominated Director Actor before planning.")
    const fingerprint = await ports.fingerprint(mission)
    const planKey = entry.key(mission)
    const saved = mission[entry.field]
    if (saved?.planKey === planKey && saved.reviewerId === actor.id && saved.fingerprint === fingerprint) return
    mission.status = "planning"
    await hooks.save(entry.stage, `${actor.id} is providing advice before the Chief Director chooses a plan.`)
    const review = parseReview(await hooks.run(actor, entry.prompt(mission), entry.stage))
    mission[entry.field] = { planKey, reviewerId: actor.id, fingerprint, review }
    await hooks.save(entry.stage, review.summary)
  }
  const limit = mission.executionPolicy?.maxParallel ?? 1
  for (let index = 0; index < entries.length; index += limit) {
    const results = await Promise.allSettled(entries.slice(index, index + limit).map(consult))
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
  }
}
