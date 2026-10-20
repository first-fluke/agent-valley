import { END, START, StateGraph, StateSchema } from "@langchain/langgraph"
import { z } from "zod"
import { approveMission, reportMission, verifyMission } from "./coordinator-completion-stages"
import { planMission, resumeMission } from "./coordinator-preparation"
import { reviewMissionGates } from "./coordinator-review-gates"
import type { CoordinatorContext, CoordinatorStage, StageTransition } from "./coordinator-stages"
import { runTaskStage } from "./coordinator-task-stage"
import { MissionPause } from "./execution"

const State = new StateSchema({
  nextStage: z.enum(["resume", "planning", "tasks", "review-gates", "verification", "approval", "report", END]),
})

/** LangGraph annotates thrown errors; keep frozen and primitive port failures intact. */
class StageFailure extends Error {
  constructor(readonly original: unknown) {
    super("Coordinator stage failed.", { cause: original })
  }
}

/** The graph schedules stages; the invocation's coordinator retains Mission ownership and durable checkpoints. */
export function createCoordinatorGraph(context: CoordinatorContext) {
  const node = (stage: (context: CoordinatorContext) => Promise<StageTransition>) => async () => {
    try {
      const transition = await stage(context)
      return { nextStage: transition.kind === "return" ? END : transition.stage }
    } catch (error) {
      throw new StageFailure(error)
    }
  }
  const next = (state: { nextStage: CoordinatorStage | typeof END }) => state.nextStage
  return new StateGraph(State)
    .addNode("resume", node(resumeMission))
    .addNode("planning", node(planMission))
    .addNode("tasks", node(runTaskStage))
    .addNode("review-gates", node(reviewMissionGates))
    .addNode("verification", node(verifyMission))
    .addNode("approval", node(approveMission))
    .addNode("report", node(reportMission))
    .addEdge(START, "resume")
    .addConditionalEdges("resume", next, ["planning", END])
    .addConditionalEdges("planning", next, ["tasks"])
    .addConditionalEdges("tasks", next, ["review-gates", "verification"])
    .addConditionalEdges("review-gates", next, ["tasks", "verification"])
    .addConditionalEdges("verification", next, ["tasks", "review-gates", "approval"])
    .addConditionalEdges("approval", next, ["tasks", "report", END])
    .addConditionalEdges("report", next, ["tasks", END])
    .compile({ name: "av-chief-coordinator" })
}

export async function runCoordinatorGraph(context: CoordinatorContext): Promise<void> {
  const tracing = ["LANGSMITH_TRACING", "LANGSMITH_TRACING_V2", "LANGCHAIN_TRACING", "LANGCHAIN_TRACING_V2"].filter(
    (name) => process.env[name]?.toLowerCase() === "true",
  )
  // Scoped tracing opt-outs are not preserved across this runtime's graph stream boundary.
  if (tracing.length)
    throw new MissionPause(
      `Local AV graph execution cannot run with remote tracing enabled: ${tracing.join(", ")}. Unset these variables in AV's process environment, then resume the saved mission.`,
      "environment",
    )
  try {
    await createCoordinatorGraph(context).invoke(
      { nextStage: "resume" },
      {
        // AV's saved call, duration, repair and recovery limits remain the termination policy.
        recursionLimit: Number.MAX_SAFE_INTEGER,
        // Cancellation stays in the existing stage/runtime path, which joins child work before returning.
        callbacks: [],
      },
    )
  } catch (error) {
    if (error instanceof StageFailure) throw error.original
    throw error
  }
}
