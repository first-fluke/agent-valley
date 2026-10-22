import { describe, expect, it } from "vitest"
import { AgySession } from "./agy-session"
import { ClaudeSession } from "./claude-session"
import { CursorSession } from "./cursor-session"
import { GrokSession } from "./grok-session"
import { KimiSession } from "./kimi-session"
import { OpencodeSession } from "./opencode-session"

describe("stateless session disposal", () => {
  it.each([ClaudeSession, CursorSession, GrokSession, KimiSession, OpencodeSession, AgySession])(
    "%s reports no active execution after disposal before execute",
    async (Session) => {
      const session = new Session()
      await session.start({ type: "fixture", timeout: 5, workspacePath: "/tmp" })
      expect(session.isAlive()).toBe(true)
      await session.dispose()
      expect(session.isAlive()).toBe(false)
    },
  )
})
