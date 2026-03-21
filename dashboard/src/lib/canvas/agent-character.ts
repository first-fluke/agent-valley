import { Container, Sprite, Texture, Ticker } from "pixi.js"
import { generateAgentSprite } from "@/lib/canvas/sprite-generator"
import { STATE_ANIMATION_MAP } from "@/features/office/utils/animations"
import type { AgentType, WorkspaceStatus } from "@/features/office/types/agent"

export class AgentCharacter {
  readonly container: Container
  private sprite: Sprite
  private agentType: AgentType
  private status: WorkspaceStatus = "idle"
  private frame = 0
  private elapsed = 0

  constructor(agentType: AgentType) {
    this.agentType = agentType
    this.container = new Container()
    this.sprite = new Sprite()
    this.container.addChild(this.sprite)

    this.updateSprite()

    Ticker.shared.add(this.animate, this)
  }

  private animate(ticker: Ticker) {
    const config = STATE_ANIMATION_MAP[this.status]
    this.elapsed += ticker.deltaMS

    const frameDuration = 1000 / config.speed
    if (this.elapsed >= frameDuration) {
      this.elapsed = 0

      if (config.loop) {
        this.frame = (this.frame + 1) % config.frameCount
      } else if (this.frame < config.frameCount - 1) {
        this.frame += 1
      }

      this.updateSprite()
    }
  }

  private updateSprite() {
    const canvas = generateAgentSprite(this.agentType, this.status, this.frame)
    const texture = Texture.from(canvas)
    this.sprite.texture = texture
  }

  setStatus(status: WorkspaceStatus) {
    if (this.status !== status) {
      this.status = status
      this.frame = 0
      this.elapsed = 0
      this.updateSprite()
    }
  }

  setPosition(x: number, y: number) {
    this.container.x = x
    this.container.y = y
  }

  destroy() {
    Ticker.shared.remove(this.animate, this)
    this.container.destroy()
  }
}
