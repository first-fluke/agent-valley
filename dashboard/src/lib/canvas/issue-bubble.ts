import { Container, Graphics, Text, TextStyle } from "pixi.js"
import type { WorkspaceStatus } from "@/features/office/types/agent"

const STATUS_COLORS: Record<WorkspaceStatus, number> = {
  idle: 0x888888,
  running: 0x4285f4,
  done: 0x34a853,
  failed: 0xff4444,
}

export class IssueBubble {
  readonly container: Container
  private bg: Graphics
  private label: Text
  private visible = false

  constructor() {
    this.container = new Container()
    this.container.visible = false

    this.bg = new Graphics()
    this.container.addChild(this.bg)

    this.label = new Text({
      text: "",
      style: new TextStyle({
        fontFamily: "monospace",
        fontSize: 7,
        fill: 0xffffff,
      }),
    })
    this.label.x = 4
    this.label.y = 3
    this.container.addChild(this.label)
  }

  show(issueKey: string, status: WorkspaceStatus) {
    this.label.text = issueKey
    const color = STATUS_COLORS[status]

    this.bg.clear()
    this.bg.roundRect(0, 0, this.label.width + 8, 14, 3)
    this.bg.fill({ color, alpha: 0.9 })

    // Speech bubble pointer
    this.bg.moveTo(8, 14)
    this.bg.lineTo(12, 18)
    this.bg.lineTo(16, 14)
    this.bg.fill({ color, alpha: 0.9 })

    this.container.visible = true
    this.visible = true
  }

  hide() {
    this.container.visible = false
    this.visible = false
  }

  setPosition(x: number, y: number) {
    this.container.x = x
    this.container.y = y
  }
}
