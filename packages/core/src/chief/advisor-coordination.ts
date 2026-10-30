import { designPlanKey, designReviewPrompt } from "./design-lead"
import { marketingPlanKey, marketingReviewPrompt } from "./marketing-lead"
import { parseReview } from "./schemas"
import { runStructuredStage, StructuredStageError } from "./structured-stage"
import { technicalPlanKey, technicalReviewPrompt } from "./technical-lead"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "./types"

export async function consultDirectors(
  mission: Mission,
  ports: ChiefPorts,
  hooks: {
    run(actor: Persona, prompt: string, stage: ChiefStage): Promise<string>
    save(stage: string, message: string): Promise<void>
    unavailable?(actor: Persona, stage: ChiefStage, error: unknown): Promise<boolean>
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
    let review: ReturnType<typeof parseReview>
    try {
      review = await runStructuredStage({
        mission,
        stage: entry.stage,
        scopeKey: `${actor.id}:${planKey}:${fingerprint}`,
        prompt: entry.prompt(mission),
        run: (prompt) => hooks.run(actor, prompt, entry.stage),
        parse: parseReview,
        save: hooks.save,
      })
    } catch (error) {
      if (error instanceof StructuredStageError) {
        delete mission[entry.field]
        mission.history.push({
          at: new Date().toISOString(),
          stage: "director-advice-unavailable",
          message: JSON.stringify({
            stage: entry.stage,
            reviewerId: actor.id,
            planKey,
            fingerprint,
            reason: error.message.slice(0, 2_000),
          }),
        })
        await hooks.save(
          "advisory-unavailable",
          `${actor.id} supplied no validated advisory response after bounded correction. The Chief must treat this as unavailable evidence, not approval.`,
        )
        return
      }
      if (hooks.unavailable && (await hooks.unavailable(actor, entry.stage, error))) return
      throw error
    }
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
