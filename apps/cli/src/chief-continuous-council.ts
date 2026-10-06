import { consultDirectors } from "@agent-valley/core/chief/advisor-coordination"
import { CheckpointError, ReadOnlyViolation } from "@agent-valley/core/chief/coordinator-run"
import { MissionPause } from "@agent-valley/core/chief/execution"
import { missionAdviceKey } from "@agent-valley/core/chief/technical-lead"
import type { ChiefPorts, ChiefStage, Mission, Persona } from "@agent-valley/core/chief/types"

/** Ordinary missing advice is evidence for the Chief; transport failures never create an opinion. */
export async function consultContinuousDirectors(
  mission: Mission,
  ports: ChiefPorts,
  run: (actor: Persona, prompt: string, stage: ChiefStage) => Promise<string>,
): Promise<void> {
  const key = async (actor: Persona, stage: ChiefStage) =>
    JSON.stringify({
      actorId: actor.id,
      stage,
      planKey: missionAdviceKey(mission),
      fingerprint: await ports.fingerprint(mission),
    })
  const save = async (stage: string, message: string) => {
    mission.history.push({ at: new Date().toISOString(), stage, message: message.slice(0, 16_000) })
    try {
      await ports.save(mission)
    } catch {
      throw new CheckpointError("Director advice checkpoint could not be saved. Its original decision was retained.")
    }
  }
  await consultDirectors(mission, ports, {
    save,
    run: async (actor, prompt, stage) => {
      const prefix = `${await key(actor, stage)}\n`
      const unavailable = mission.history.findLast(
        (entry) => entry.stage === "continuous-advisor-unavailable" && entry.message.startsWith(prefix),
      )
      if (unavailable) throw new Error(unavailable.message.slice(prefix.length))
      return run(actor, prompt, stage)
    },
    unavailable: async (actor, stage, error) => {
      if (
        error instanceof ReadOnlyViolation ||
        error instanceof CheckpointError ||
        (error instanceof MissionPause && ["budget", "interrupted", "integrity", "unknown-effect"].includes(error.kind))
      )
        return false
      const prefix = `${await key(actor, stage)}\n`
      if (
        !mission.history.some(
          (entry) => entry.stage === "continuous-advisor-unavailable" && entry.message.startsWith(prefix),
        )
      )
        await save(
          "continuous-advisor-unavailable",
          `${prefix}${error instanceof Error ? error.message : String(error)}`,
        )
      return true
    },
  })
}

export function continuousDirectorAdvice(mission: Mission) {
  return {
    technical: mission.technicalReview ?? null,
    design: mission.designReview ?? null,
    marketing: mission.marketingReview ?? null,
    unavailable: mission.history.filter((entry) => entry.stage === "continuous-advisor-unavailable").slice(-10),
  }
}
