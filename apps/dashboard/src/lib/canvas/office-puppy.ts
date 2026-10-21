import { Container, Sprite, type Ticker } from "pixi.js"
import { TILE_SIZE } from "@/features/office/utils/office-layout"
import { getPuppyTexture } from "@/lib/canvas/sprite-generator"

const WANDER_SPEED = 0.6
const WALK_FRAME_INTERVAL = 250
const MIN_PAUSE = 1500
const MAX_PAUSE = 4000
const POOP_CHANCE = 0.08
const POOP_COOLDOWN = 15000

export class OfficePuppy {
  readonly container: Container
  private sprite: Sprite
  private ticker: Ticker
  private walkableTiles: { col: number; row: number }[]
  private frame = 0
  private elapsed = 0
  private targetX = 0
  private targetY = 0
  private isMoving = false
  private pauseRemaining: number
  private poopCooldown = 0
  onPoop: ((x: number, y: number) => void) | null = null

  constructor(walkableTiles: { col: number; row: number }[], ticker: Ticker) {
    this.walkableTiles = walkableTiles
    this.ticker = ticker
    this.container = new Container()
    this.sprite = new Sprite()
    this.container.addChild(this.sprite)

    // Start at a random walkable tile
    const startTile = walkableTiles[Math.floor(Math.random() * walkableTiles.length)]!
    this.container.x = startTile.col * TILE_SIZE + 6
    this.container.y = startTile.row * TILE_SIZE + 6
    this.targetX = this.container.x
    this.targetY = this.container.y

    this.pauseRemaining = MIN_PAUSE + Math.random() * (MAX_PAUSE - MIN_PAUSE)
    this.updateSprite()

    this.ticker.add(this.animate, this)
  }

  private animate(ticker: Ticker) {
    const dt = ticker.deltaMS

    this.poopCooldown = Math.max(0, this.poopCooldown - dt)

    if (this.isMoving) {
      this.moveToward(this.targetX, this.targetY)
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
        this.tryPoop()
        this.pickTarget()
      }
    }

    this.elapsed += dt
    const interval = this.isMoving ? WALK_FRAME_INTERVAL : 500
    if (this.elapsed >= interval) {
      this.elapsed = 0
      this.frame = (this.frame + 1) % 4
      this.updateSprite()
    }
  }

  private moveToward(tx: number, ty: number) {
    const dx = tx - this.container.x
    const dy = ty - this.container.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= WANDER_SPEED) {
      this.container.x = tx
      this.container.y = ty
    } else {
      this.container.x += (dx / dist) * WANDER_SPEED
      this.container.y += (dy / dist) * WANDER_SPEED
    }

    // Flip sprite based on direction
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

  private pickTarget() {
    const tile = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]!
    this.targetX = tile.col * TILE_SIZE + 6
    this.targetY = tile.row * TILE_SIZE + 6
    this.isMoving = true
    this.frame = 0
    this.elapsed = 0
  }

  private tryPoop() {
    if (this.poopCooldown > 0) return
    if (Math.random() > POOP_CHANCE) return
    this.poopCooldown = POOP_COOLDOWN
    this.onPoop?.(this.container.x, this.container.y)
  }

  private updateSprite() {
    this.sprite.texture = getPuppyTexture(this.frame, this.isMoving)
  }

  destroy() {
    this.ticker.remove(this.animate, this)
    this.container.destroy({ children: true })
  }
}
