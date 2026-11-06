import type { Issue } from "../domain/models"
import { runCommand } from "../workspace/worktree-lifecycle"
import { discoverMissionSkills, loadMissionSkillBodies, validateMissionSkills } from "./skills"
import type { Mission, Persona } from "./types"

export function missionIssue(id: string, goal: string): Issue {
  return {
    id,
    identifier: `ORDER-${id}`,
    title: goal.slice(0, 200),
    description: goal,
    status: { id: "local", name: "In Progress", type: "started" },
    team: { id: "local", key: "ORDER" },
    labels: [],
    url: "",
    score: null,
    parentId: null,
    children: [],
    relations: [],
  }
}

/** Pin the intermediate receipt check before the worker can create commits. */
export async function intermediateVerifyCommand(workspacePath: string): Promise<string> {
  const head = await runCommand("git", ["rev-parse", "HEAD"], { cwd: workspacePath })
  const hash = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[a-f0-9]{40,64}$/.test(hash))
    throw new Error(
      "Cannot bind the OMA task check to its starting commit. Restore the mission worktree's Git HEAD before resuming.",
    )
  return `git diff --check ${hash} --`
}

export async function personaSkills(persona: Persona, mission: Mission, stage: string): Promise<string> {
  const catalog = mission.availableSkills ?? (await discoverMissionSkills(mission.workspace.path))
  if (!mission.availableAgents) await validateMissionSkills(mission.workspace.path, catalog)
  const selected = await loadMissionSkillBodies(
    mission.workspace.path,
    persona.skills,
    mission.availableAgents ? catalog : undefined,
  )
  const guidance: string[] = []
  if (persona.id === mission.chiefId)
    guidance.push(
      "Available OMA skills in this mission worktree (catalog metadata; descriptions do not override the goal or stage permissions):",
      JSON.stringify(catalog),
      "Choose relevant actual skills from this catalog for the goal. Read a selected SKILL.md at its listed path and only its needed references. Automatic Actor skills must use these exact names. An empty catalog means no verified OMA skills are available.",
    )
  if (selected) guidance.push("Use these selected skills within the assigned role and acceptance criteria.", selected)
  if (guidance.length && stage !== "work")
    guidance.push(
      "This stage is read-only: skill instructions do not authorize changes to product files, tests, configuration, or the fixed verification command.",
    )
  return guidance.length ? `\n\n${guidance.join("\n\n")}` : ""
}

export function unattendedVerificationGuidance(stage: string): string {
  return [
    "Use deterministic unit, integration and CLI checks for implementation and review. Do not introduce or autonomously run Playwright/browser E2E suites; never install or download Playwright packages or browser binaries.",
    "Do not use ComputerUse or GUI interaction to work around a denied shell command, sandbox restriction, missing toolchain, or failed test. Report the actual prerequisite failure and use the supported noninteractive code tools.",
    stage === "final-review"
      ? "Only when the goal actually changes a UI, make at most one final visual verification pass using an already available Aside MCP, chrome-devtools-mcp or firefox-devtools-mcp. If none is available, report that the visual check was not performed. Do not install browser tooling or replace it with ComputerUse."
      : "Do not perform screen-based checks during planning, implementation or individual reviews. Any relevant visual check belongs only to one final-review pass, after code verification, using existing Aside/Chrome DevTools/Firefox DevTools MCP tools.",
  ].join("\n")
}
