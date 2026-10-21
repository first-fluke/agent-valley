import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"
import { InterventionPanel } from "../features/orchestrator/components/intervention-panel"

afterEach(cleanup)

const claudeAttempt = { attemptId: "att-1", issueKey: "PROJ-1", agentType: "claude" }

describe("InterventionPanel render behaviour", () => {
  test("renders a modal dialog for the selected attempt", () => {
    render(<InterventionPanel attempt={claudeAttempt} onClose={() => {}} />)

    const dialog = screen.getByRole("dialog", { name: "Actor intervention" })
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    expect(screen.getByText(/PROJ-1/)).toBeTruthy()
    expect(screen.getByText("claude")).toBeTruthy()
  })

  test("closes on Escape", () => {
    const onClose = vi.fn()
    render(<InterventionPanel attempt={claudeAttempt} onClose={onClose} />)

    fireEvent.keyDown(document, { key: "Escape" })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test("moves focus to the close button when opened", () => {
    render(<InterventionPanel attempt={claudeAttempt} onClose={() => {}} />)

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close intervention panel" }))
  })

  test("disables actions the registry does not advertise for the agent", () => {
    render(<InterventionPanel attempt={{ ...claudeAttempt, agentType: "qwen" }} onClose={() => {}} />)

    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole("button", { name: "Abort" }) as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText("Append prompt") as HTMLTextAreaElement).disabled).toBe(true)
  })

  test("keeps append_prompt available for stateless Claude runs", () => {
    render(<InterventionPanel attempt={claudeAttempt} onClose={() => {}} />)

    expect((screen.getByLabelText("Append prompt") as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByRole("button", { name: "Pause" }) as HTMLButtonElement).disabled).toBe(true)
  })

  test("posts the selected command for the attempt", async () => {
    const post = vi.fn(async () => ({ ok: true }))
    render(<InterventionPanel attempt={claudeAttempt} onClose={() => {}} post={post} />)

    fireEvent.click(screen.getByRole("button", { name: "Abort" }))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post).toHaveBeenCalledWith({
      attemptId: "att-1",
      command: { kind: "abort", reason: "operator_requested" },
    })
    await screen.findByText("Command dispatched")
  })

  test("renders nothing without a selected attempt", () => {
    const { container } = render(<InterventionPanel attempt={null} onClose={() => {}} />)

    expect(container.innerHTML).toBe("")
  })
})
