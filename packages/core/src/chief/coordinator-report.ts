import type { createMissionRun } from "./coordinator-run"
import { fallbackReport, parseReport, reportPrompt } from "./reports"
import { reviewGatesAreCurrent } from "./review-gate-check"
import type { ChiefPorts, Mission, Persona } from "./types"

export function createMissionReporter(
  mission: Mission,
  ports: ChiefPorts,
  run: ReturnType<typeof createMissionRun>,
  persona: (id: string) => Persona,
  fatal: (error: unknown) => boolean,
): () => Promise<void> {
  return async () => {
    if (!mission.supervision) return
    if (ports.signal?.aborted) {
      mission.report = fallbackReport(mission)
      return
    }
    const draft =
      mission.status === "reviewing" &&
      mission.verification?.ok &&
      mission.finalReview?.passed &&
      reviewGatesAreCurrent(mission, mission.verification.fingerprint)
    if (draft) {
      // The final scheduler checks still own completion; prose generation needs no extra Actor budget.
      mission.report = fallbackReport({ ...mission, status: "completed" })
      return
    }
    try {
      mission.report = parseReport(await run(persona(mission.chiefId), reportPrompt(mission), "report"))
    } catch (error) {
      if (fatal(error)) throw error
      mission.report = fallbackReport(mission)
    }
  }
}
