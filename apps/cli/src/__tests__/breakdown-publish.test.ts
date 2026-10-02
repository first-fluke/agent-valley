import type { Config } from "@agent-valley/core/config/yaml-loader"
import { createIssueRelation, ensureIssueLabelId, updateIssueState } from "@agent-valley/core/tracker/linear-client"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BreakdownResult } from "../breakdown"
import { publishBreakdown, validateBreakdown } from "../breakdown-publish"
import { createLinearIssueInState, findDraftState } from "../linear-issue"

vi.mock("@agent-valley/core/tracker/linear-client", () => ({
  createIssueRelation: vi.fn(),
  ensureIssueLabelId: vi.fn(),
  updateIssueState: vi.fn(),
}))
vi.mock("../linear-issue", () => ({ createLinearIssueInState: vi.fn(), findDraftState: vi.fn() }))

const config = { linearApiKey: "key", linearTeamUuid: "team", workflowStates: { todo: "todo" } } as Config
const breakdown: BreakdownResult = {
  parentTitle: "Feature",
  parentDescription: "Build feature",
  subIssues: [
    { title: "Schema", description: "Tables", blockedByIndices: [] },
    { title: "API", description: "Routes", blockedByIndices: [1] },
  ],
}
let events: string[]
beforeEach(() => {
  vi.resetAllMocks()
  events = []
  vi.mocked(findDraftState).mockResolvedValue("backlog")
  vi.mocked(ensureIssueLabelId).mockResolvedValue("scope-id")
  vi.mocked(createLinearIssueInState).mockImplementation(async (_config, input) => {
    events.push(`create:${input.title}:${input.stateId}`)
    return { id: input.title, identifier: input.title, title: input.title, url: `https://linear.app/${input.title}` }
  })
  vi.mocked(createIssueRelation).mockImplementation(async (_key, blocker, blocked) => {
    events.push(`relation:${blocker}:${blocked}`)
  })
  vi.mocked(updateIssueState).mockImplementation(async (_key, id, state) => {
    events.push(`publish:${id}:${state}`)
  })
})

describe("breakdown publication", () => {
  it("prepares the complete DAG before publishing any task", async () => {
    const result = await publishBreakdown(config, breakdown, "api")
    expect(events).toEqual([
      "create:Feature:backlog",
      "create:Schema:backlog",
      "create:API:backlog",
      "relation:Schema:API",
      "publish:API:todo",
      "publish:Schema:todo",
      "publish:Feature:todo",
    ])
    expect(result.relationsCreated).toBe(1)
    expect(ensureIssueLabelId).toHaveBeenCalledWith("key", "team", "scope:api")
    expect(createLinearIssueInState).toHaveBeenNthCalledWith(
      2,
      config,
      expect.objectContaining({ parentId: "Feature", labelIds: ["scope-id"] }),
    )
  })

  it("does not publish a partial breakdown after a child creation failure", async () => {
    vi.mocked(createLinearIssueInState).mockRejectedValueOnce(new Error("parent rejected"))
    await expect(publishBreakdown(config, breakdown)).rejects.toThrow("parent rejected")
    expect(updateIssueState).not.toHaveBeenCalled()
  })

  it("keeps all created drafts out of Todo if dependencies fail", async () => {
    vi.mocked(createIssueRelation).mockRejectedValue(new Error("permission denied"))
    await expect(publishBreakdown(config, breakdown)).rejects.toThrow("remain in Backlog")
    expect(updateIssueState).not.toHaveBeenCalled()
  })

  it("reports partial publication without claiming every issue is still in Backlog", async () => {
    vi.mocked(updateIssueState).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("rate limit"))
    await expect(publishBreakdown(config, breakdown)).rejects.toThrow("Some tasks may already be in Todo")
  })
})

describe("breakdown validation", () => {
  it.each([0, -1, 3, 1.5, Number.NaN, 2])("rejects invalid/self dependency %s before writing", async (dependency) => {
    const invalid = {
      ...breakdown,
      subIssues: breakdown.subIssues.map((issue, index) =>
        index === 1 ? { ...issue, blockedByIndices: [dependency] } : issue,
      ),
    }
    await expect(publishBreakdown(config, invalid)).rejects.toThrow("invalid dependency")
    expect(createLinearIssueInState).not.toHaveBeenCalled()
  })

  it("rejects cycles and empty plans", () => {
    expect(() =>
      validateBreakdown({
        ...breakdown,
        subIssues: breakdown.subIssues.map((issue, index) => ({ ...issue, blockedByIndices: [index === 0 ? 2 : 1] })),
      }),
    ).toThrow("cycle")
    expect(() => validateBreakdown({ ...breakdown, subIssues: [] })).toThrow("at least one")
  })
})
