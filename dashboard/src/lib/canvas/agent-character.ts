import { Container, Sprite, type Ticker } from "pixi.js"
import { getAgentTexture } from "@/lib/canvas/sprite-generator"
import { STATE_ANIMATION_MAP } from "@/features/office/utils/animations"
import { TILE_SIZE } from "@/features/office/utils/office-layout"
import type { AgentType, CharacterSkin, WorkspaceStatus } from "@/features/office/types/agent"

const WANDER_SPEED = 1.2
const RETURN_SPEED = 2.0
const WALK_FRAME_INTERVAL = 200
const MIN_PAUSE = 2000
const MAX_PAUSE = 5000
const INTEREST_POINT_CHANCE = 0.35

export class AgentCharacter {
  readonly container: Container
  private sprite: Sprite
  private ticker: Ticker
  private agentType: AgentType
  private skin: CharacterSkin
  private status: WorkspaceStatus = "idle"
  private frame = 0
  private elapsed = 0
  private walkableTiles: { col: number; row: number }[]
  private interestPoints: { col: number; row: number }[]

  // Wander state
  private homeX = 0
  private homeY = 0
  private targetX = 0
  private targetY = 0
  private isMoving = false
  private pauseRemaining = 0
  private atHome = true

  constructor(
    agentType: AgentType,
    skin: CharacterSkin,
    walkableTiles: { col: number; row: number }[],
    interestPoints: { col: number; row: number }[],
    ticker: Ticker,
  ) {
    this.agentType = agentType
    this.skin = skin
    this.walkableTiles = walkableTiles
    this.interestPoints = interestPoints
    this.ticker = ticker
    this.container = new Container()
    this.sprite = new Sprite()
    this.container.addChild(this.sprite)

    this.updateSprite()

    this.pauseRemaining = MIN_PAUSE + Math.random() * MAX_PAUSE

    this.ticker.add(this.animate, this)
  }

  private animate(ticker: Ticker) {
    const dt = ticker.deltaMS

    if (this.status === "idle") {
      this.updateIdle(dt)
    } else if (!this.atHome) {
      this.moveToward(this.homeX, this.homeY, RETURN_SPEED)
      if (this.isNear(this.homeX, this.homeY)) {
        this.container.x = this.homeX
        this.container.y = this.homeY
        this.atHome = true
        this.isMoving = false
        this.frame = 0
        this.elapsed = 0
        this.resetFacing()
        this.updateSprite()
        return
      }
    }

    this.elapsed += dt
    if (this.isMoving) {
      if (this.elapsed >= WALK_FRAME_INTERVAL) {
        this.elapsed = 0
        this.frame = (this.frame + 1) % 4
        this.updateSprite()
      }
    } else {
      const config = STATE_ANIMATION_MAP[this.status]
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
  }

  private updateIdle(dt: number) {
    if (this.isMoving) {
      this.moveToward(this.targetX, this.targetY, WANDER_SPEED)
      if (this.isNear(this.targetX, this.targetY)) {
        this.container.x = this.targetX
        this.container.y = this.targetY
        this.isMoving = false
        this.pauseRemaining = MIN_PAUSE + Math.random() * (MAX_PAUSE - MIN_PAUSE)
        this.frame = 0
        this.elapsed = 0
        this.updateSprite()
      }
    } else {
      this.pauseRemaining -= dt
      if (this.pauseRemaining <= 0) {
        this.pickWanderTarget()
      }
    }
  }

  private moveToward(tx: number, ty: number, speed: number) {
    const dx = tx - this.container.x
    const dy = ty - this.container.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= speed) {
      this.container.x = tx
      this.container.y = ty
    } else {
      this.container.x += (dx / dist) * speed
      this.container.y += (dy / dist) * speed
    }

    if (dx < -0.5) {
      this.sprite.scale.x = -1
      this.sprite.anchor.x = 1
    } else if (dx > 0.5) {
      this.sprite.scale.x = 1
      this.sprite.anchor.x = 0
    }
  }

  private isNear(x: number, y: number): boolean {
    return Math.abs(this.container.x - x) < 2 && Math.abs(this.container.y - y) < 2
  }

  private pickWanderTarget() {
    let tile: { col: number; row: number }

    if (this.interestPoints.length > 0 && Math.random() < INTEREST_POINT_CHANCE) {
      tile = this.interestPoints[Math.floor(Math.random() * this.interestPoints.length)]
    } else {
      tile = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
    }

    this.targetX = tile.col * TILE_SIZE
    this.targetY = tile.row * TILE_SIZE
    this.isMoving = true
    this.atHome = false
    this.frame = 0
    this.elapsed = 0
  }

  private resetFacing() {
    this.sprite.scale.x = 1
    this.sprite.anchor.x = 0
  }

  private updateSprite() {
    this.sprite.texture = getAgentTexture(this.agentType, this.status, this.frame, this.isMoving, this.skin)
  }

  setStatus(status: WorkspaceStatus) {
    if (this.status !== status) {
      this.status = status
      this.frame = 0
      this.elapsed = 0

      if (status !== "idle") {
        this.isMoving = !this.atHome
        if (this.atHome) {
          this.resetFacing()
        }
      } else {
        this.isMoving = false
        this.pauseRemaining = MIN_PAUSE + Math.random() * (MAX_PAUSE - MIN_PAUSE)
      }

      this.updateSprite()
    }
  }

  setAgentType(agentType: AgentType) {
    if (this.agentType !== agentType) {
      this.agentType = agentType
      this.updateSprite()
    }
  }

  setPosition(x: number, y: number) {
    this.container.x = x
    this.container.y = y
    this.homeX = x
    this.homeY = y
    this.targetX = x
    this.targetY = y
  }

  destroy() {
    this.ticker.remove(this.animate, this)
    this.container.destroy({ children: true })
  }
}
