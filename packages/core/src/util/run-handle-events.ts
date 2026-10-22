import type { AgentRunEvent, Unsubscribe } from "../domain/ports/agent-runner"

export class RunHandleEmitter {
  private readonly handlers = new Set<(event: AgentRunEvent) => void>()
  private readonly lifecycle: AgentRunEvent[] = []

  subscribe(handler: (event: AgentRunEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    // A run may finish during start(). Its lifecycle remains observable after spawn().
    for (const event of this.lifecycle) this.deliver(handler, event)
    return () => {
      this.handlers.delete(handler)
    }
  }

  emit(event: AgentRunEvent): void {
    if (event.kind !== "output") this.lifecycle.push(event)
    for (const handler of [...this.handlers]) this.deliver(handler, event)
  }

  private deliver(handler: (event: AgentRunEvent) => void, event: AgentRunEvent): void {
    try {
      handler(event)
    } catch {
      // Subscribers cannot disrupt execution or other observers.
    }
  }
}
