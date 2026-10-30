import { Container, Sprite, type Ticker } from "pixi.js"
import type { AgentType, CharacterSkin, WorkspaceStatus } from "@/features/office/types/agent"
import { STATE_ANIMATION_MAP } from "@/features/office/utils/animations"
import { TILE_SIZE } from "@/features/office/utils/office-layout"
import { getAgentTexture, getCoffeeCupTexture } from "@/lib/canvas/sprite-generator"
import { requireCanvasValue } from "./required-value"

const WANDER_SPEED = 1.2
const RETURN_SPEED = 2.0
const WALK_FRAME_INTERVAL = 200
const MIN_PAUSE = 2000
const MAX_PAUSE = 5000
const INTEREST_POINT_CHANCE = 0.35
const COFFEE_DRINK_DURATION = 6000

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

  // Cleanup state
  private cleanupTarget: { x: number; y: number } | null = null
  private isCleaningUp = false
  private cleanupTimer = 0
  onCleanupDone: ((x: number, y: number) => void) | null = null

  // Coffee state
  private coffeeSprite: Sprite | null = null
  private coffeeTimer = 0
  private coffeeFrame = 0
  private coffeeElapsed = 0
  private coffeePointSet = new Set<string>()

  // Interest point filter (for semaphore-like bathroom access)
  isInterestPointAvailable: ((col: number, row: number) => boolean) | null = null
  // Waypoint: returns an intermediate point to walk to before the final target
  getWaypoint: ((col: number, row: number) => { col: number; row: number } | null) | null = null
  // Exit waypoint: returns a point to walk to first when LEAVING a special area
  getExitWaypoint: ((fromX: number, fromY: number) => { col: number; row: number } | null) | null = null
  private pendingFinalTarget: { x: number; y: number } | null = null

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
    this.updateCoffee(dt)

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
    // Cleanup takes priority
    if (this.isCleaningUp) {
      this.cleanupTimer -= dt
      if (this.cleanupTimer <= 0) {
        this.isCleaningUp = false
        const target = requireCanvasValue(this.cleanupTarget, "a cleanup target")
        this.cleanupTarget = null
        this.pauseRemaining = 500
        this.onCleanupDone?.(target.x, target.y)
      }
      return
    }

    if (this.cleanupTarget) {
      this.moveToward(this.cleanupTarget.x, this.cleanupTarget.y, RETURN_SPEED)
      if (this.isNear(this.cleanupTarget.x, this.cleanupTarget.y)) {
        this.container.x = this.cleanupTarget.x
        this.container.y = this.cleanupTarget.y
        this.isCleaningUp = true
        this.cleanupTimer = 1200
        this.isMoving = false
        this.frame = 0
        this.elapsed = 0
        this.updateSprite()
      }
      return
    }

    if (this.isMoving) {
      this.moveToward(this.targetX, this.targetY, WANDER_SPEED)
      if (this.isNear(this.targetX, this.targetY)) {
        this.container.x = this.targetX
        this.container.y = this.targetY

        // If waypoint reached, continue to final target
        if (this.pendingFinalTarget) {
          this.targetX = this.pendingFinalTarget.x
          this.targetY = this.pendingFinalTarget.y
          this.pendingFinalTarget = null
          this.frame = 0
          this.elapsed = 0
          return
        }

        this.isMoving = false
        this.pauseRemaining = MIN_PAUSE + Math.random() * (MAX_PAUSE - MIN_PAUSE)
        this.frame = 0
        this.elapsed = 0
        this.updateSprite()

        if (this.isCoffeePoint(this.targetX, this.targetY)) {
          this.pickUpCoffee()
        }
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
    const pickRandom = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)] as T
    let tile: { col: number; row: number }

    if (this.interestPoints.length > 0 && Math.random() < INTEREST_POINT_CHANCE) {
      const available = this.isInterestPointAvailable
        ? this.interestPoints.filter((p) =>
            requireCanvasValue(this.isInterestPointAvailable, "an interest-point predicate").call(this, p.col, p.row),
          )
        : this.interestPoints
      tile = available.length > 0 ? pickRandom(available) : pickRandom(this.walkableTiles)
    } else {
      tile = pickRandom(this.walkableTiles)
    }

    const finalX = tile.col * TILE_SIZE
    const finalY = tile.row * TILE_SIZE

    // Check if leaving a special area (e.g. exiting bathroom)
    const exitWp = this.getExitWaypoint?.(this.container.x, this.container.y)
    if (exitWp) {
      this.targetX = exitWp.col * TILE_SIZE
      this.targetY = exitWp.row * TILE_SIZE
      this.pendingFinalTarget = { x: finalX, y: finalY }
      // Check if entering a special area (e.g. entering bathroom)
    } else {
      const entryWp = this.getWaypoint?.(tile.col, tile.row)
      if (entryWp) {
        this.targetX = entryWp.col * TILE_SIZE
        this.targetY = entryWp.row * TILE_SIZE
        this.pendingFinalTarget = { x: finalX, y: finalY }
      } else {
        this.targetX = finalX
        this.targetY = finalY
        this.pendingFinalTarget = null
      }
    }

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

  assignCleanup(x: number, y: number) {
    this.cleanupTarget = { x, y }
    this.isMoving = true
    this.atHome = false
    this.frame = 0
    this.elapsed = 0
  }

  get isBusyCleaning(): boolean {
    return this.cleanupTarget !== null || this.isCleaningUp
  }

  get currentStatus(): WorkspaceStatus {
    return this.status
  }

  setCoffeePoints(points: { col: number; row: number }[]) {
    this.coffeePointSet = new Set(points.map((p) => `${p.col},${p.row}`))
  }

  private isCoffeePoint(x: number, y: number): boolean {
    const col = Math.round(x / TILE_SIZE)
    const row = Math.round(y / TILE_SIZE)
    return this.coffeePointSet.has(`${col},${row}`)
  }

  private pickUpCoffee() {
    if (this.coffeeSprite) return
    this.coffeeFrame = 0
    this.coffeeElapsed = 0
    this.coffeeTimer = COFFEE_DRINK_DURATION
    this.coffeeSprite = new Sprite(getCoffeeCupTexture(0))
    this.coffeeSprite.x = 20
    this.coffeeSprite.y = 14
    this.container.addChild(this.coffeeSprite)
  }

  private updateCoffee(dt: number) {
    if (!this.coffeeSprite) return
    this.coffeeTimer -= dt
    if (this.coffeeTimer <= 0) {
      this.container.removeChild(this.coffeeSprite)
      this.coffeeSprite.destroy()
      this.coffeeSprite = null
      return
    }
    this.coffeeElapsed += dt
    if (this.coffeeElapsed >= 400) {
      this.coffeeElapsed = 0
      this.coffeeFrame = (this.coffeeFrame + 1) % 3
      this.coffeeSprite.texture = getCoffeeCupTexture(this.coffeeFrame)
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
