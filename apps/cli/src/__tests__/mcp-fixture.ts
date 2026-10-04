import { vi } from "vitest"
import type { MissionApiPort } from "../mcp-contract"

export function missionApiFixture() {
  return {
    order: vi.fn<MissionApiPort["order"]>().mockResolvedValue({ missionId: "test-mission", status: "queued" }),
    list: vi
      .fn<MissionApiPort["list"]>()
      .mockResolvedValue({ missions: [{ missionId: "test-mission", status: "waiting" }] }),
    status: vi
      .fn<MissionApiPort["status"]>()
      .mockResolvedValue({ missionId: "test-mission", status: "waiting", evidence: [{ actual: true, passed: true }] }),
    report: vi.fn<MissionApiPort["report"]>().mockResolvedValue({
      missionId: "test-mission",
      markdown: "# Actual report\n\nEasy explanation: measured evidence is pending.\n",
    }),
    resume: vi.fn<MissionApiPort["resume"]>().mockResolvedValue({ missionId: "test-mission", status: "queued" }),
    cancel: vi.fn<MissionApiPort["cancel"]>().mockResolvedValue({ missionId: "test-mission", status: "paused" }),
    close: vi.fn<MissionApiPort["close"]>().mockResolvedValue(),
  }
}
