import { Container, Sprite, type Ticker } from "pixi.js"
import { TILE_SIZE } from "@/features/office/utils/office-layout"
import { getCockatooTexture } from "@/lib/canvas/sprite-generator"
import { requireCanvasValue } from "./required-value"

const FLY_SPEED = 1.8
const FLY_FRAME_INTERVAL = 150
const PERCH_FRAME_INTERVAL = 600
const MIN_PERCH = 5000
const MAX_PERCH = 12000
const PERCH_Y_OFFSET = -6

export class OfficeCockatoo {
  readonly container: Container
  private sprite: Sprite
  private ticker: Ticker
  private plantPositions: { col: number; row: number }[]
  private frame = 0
  private elapsed = 0
  private targetX = 0
  private targetY = 0
  private isFlying = false
  private perchRemaining: number
  private currentPlantIndex = 0

  constructor(plantPositions: { col: number; row: number }[], ticker: Ticker) {
    this.plantPositions = plantPositions
    this.ticker = ticker
    this.container = new Container()
    this.sprite = new Sprite()
    this.container.addChild(this.sprite)

    // Start perched on a random plant
    this.currentPlantIndex = Math.floor(Math.random() * plantPositions.length)
    const startPlant = requireCanvasValue(plantPositions[this.currentPlantIndex], "a starting plant")
    this.container.x = startPlant.col * TILE_SIZE + 8
    this.container.y = startPlant.row * TILE_SIZE + PERCH_Y_OFFSET
    this.targetX = this.container.x
    this.targetY = this.container.y

    this.perchRemaining = MIN_PERCH + Math.random() * (MAX_PERCH - MIN_PERCH)
    this.updateSprite()

    this.ticker.add(this.animate, this)
  }

  private animate(ticker: Ticker) {
    const dt = ticker.deltaMS

    if (this.isFlying) {
      this.flyToward(this.targetX, this.targetY)
      if (this.isNear(this.targetX, this.targetY)) {
        this.container.x = this.targetX
        this.container.y = this.targetY
        this.isFlying = false
        this.perchRemaining = MIN_PERCH + Math.random() * (MAX_PERCH - MIN_PERCH)
        this.frame = 0
        this.elapsed = 0
        this.updateSprite()
      }
    } else {
      this.perchRemaining -= dt
      if (this.perchRemaining <= 0) {
        this.pickNextPlant()
      }
    }

    this.elapsed += dt
    const interval = this.isFlying ? FLY_FRAME_INTERVAL : PERCH_FRAME_INTERVAL
    if (this.elapsed >= interval) {
      this.elapsed = 0
      this.frame = (this.frame + 1) % 4
      this.updateSprite()
    }
  }

  private flyToward(tx: number, ty: number) {
    const dx = tx - this.container.x
    const dy = ty - this.container.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist <= FLY_SPEED) {
      this.container.x = tx
      this.container.y = ty
    } else {
      // Arc upward while flying — parabolic Y offset
      const progress = 1 - dist / this.flyDistance()
      const arcHeight = -20 * (progress * (1 - progress))
      this.container.x += (dx / dist) * FLY_SPEED
      this.container.y += (dy / dist) * FLY_SPEED + arcHeight * 0.02
    }

    // Flip based on direction
    if (dx < -0.5) {
      this.sprite.scale.x = -1
      this.sprite.anchor.x = 1
    } else if (dx > 0.5) {
      this.sprite.scale.x = 1
      this.sprite.anchor.x = 0
    }
  }

  private flyDistance(): number {
    const plant = requireCanvasValue(this.plantPositions[this.currentPlantIndex], "a target plant")
    const tx = plant.col * TILE_SIZE + 8
    const ty = plant.row * TILE_SIZE + PERCH_Y_OFFSET
    const dx = tx - this.container.x
    const dy = ty - this.container.y
    return Math.max(1, Math.sqrt(dx * dx + dy * dy))
  }

  private isNear(x: number, y: number): boolean {
    return Math.abs(this.container.x - x) < 2 && Math.abs(this.container.y - y) < 2
  }

  private pickNextPlant() {
    if (this.plantPositions.length <= 1) return

    let nextIndex: number
    do {
      nextIndex = Math.floor(Math.random() * this.plantPositions.length)
    } while (nextIndex === this.currentPlantIndex)

    this.currentPlantIndex = nextIndex
    const plant = requireCanvasValue(this.plantPositions[this.currentPlantIndex], "a target plant")
    this.targetX = plant.col * TILE_SIZE + 8
    this.targetY = plant.row * TILE_SIZE + PERCH_Y_OFFSET
    this.isFlying = true
    this.frame = 0
    this.elapsed = 0
  }

  private updateSprite() {
    this.sprite.texture = getCockatooTexture(this.frame, this.isFlying)
  }

  destroy() {
    this.ticker.remove(this.animate, this)
    this.container.destroy({ children: true })
  }
}
