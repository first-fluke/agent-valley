import { Application, Container, Graphics, Sprite, Texture, Text, TextStyle } from "pixi.js"
import {
  TILE_SIZE,
  OFFICE_COLS,
  OFFICE_ROWS,
  OFFICE_WIDTH,
  OFFICE_HEIGHT,
  DESK_POSITIONS,
  FURNITURE_POSITIONS,
} from "@/features/office/utils/office-layout"
import { generateFurnitureSprite } from "@/lib/canvas/sprite-generator"
import { AgentCharacter } from "@/lib/canvas/agent-character"
import { IssueBubble } from "@/lib/canvas/issue-bubble"
import type { AgentType, OrchestratorState, WorkspaceStatus } from "@/features/office/types/agent"

const AGENT_TYPES: AgentType[] = ["claude", "codex", "gemini"]

export class OfficeScene {
  private app: Application
  private floorLayer: Container
  private furnitureLayer: Container
  private characterLayer: Container
  private uiLayer: Container
  private characters: Map<AgentType, AgentCharacter> = new Map()
  private bubbles: Map<AgentType, IssueBubble> = new Map()
  private initialized = false

  constructor() {
    this.app = new Application()
    this.floorLayer = new Container()
    this.furnitureLayer = new Container()
    this.characterLayer = new Container()
    this.uiLayer = new Container()
  }

  async init(canvas: HTMLCanvasElement) {
    if (this.initialized) return

    await this.app.init({
      canvas,
      width: OFFICE_WIDTH,
      height: OFFICE_HEIGHT,
      backgroundColor: 0x1a1a2e,
      antialias: false,
      resolution: 2,
      autoDensity: true,
    })

    this.app.stage.addChild(this.floorLayer)
    this.app.stage.addChild(this.furnitureLayer)
    this.app.stage.addChild(this.characterLayer)
    this.app.stage.addChild(this.uiLayer)

    this.drawFloor()
    this.drawWalls()
    this.drawFurniture()
    this.createDesks()
    this.createCharacters()

    this.initialized = true
  }

  private drawFloor() {
    const floorCanvas = generateFurnitureSprite("floor")
    const texture = Texture.from(floorCanvas)

    for (let row = 2; row < OFFICE_ROWS - 1; row++) {
      for (let col = 1; col < OFFICE_COLS - 1; col++) {
        const sprite = new Sprite(texture)
        sprite.x = col * TILE_SIZE
        sprite.y = row * TILE_SIZE
        this.floorLayer.addChild(sprite)
      }
    }
  }

  private drawWalls() {
    const wallCanvas = generateFurnitureSprite("wall")
    const texture = Texture.from(wallCanvas)

    // Top and bottom walls
    for (let col = 0; col < OFFICE_COLS; col++) {
      const topWall = new Sprite(texture)
      topWall.x = col * TILE_SIZE
      topWall.y = 0
      this.floorLayer.addChild(topWall)

      const topWall2 = new Sprite(texture)
      topWall2.x = col * TILE_SIZE
      topWall2.y = TILE_SIZE
      this.floorLayer.addChild(topWall2)

      const bottomWall = new Sprite(texture)
      bottomWall.x = col * TILE_SIZE
      bottomWall.y = (OFFICE_ROWS - 1) * TILE_SIZE
      this.floorLayer.addChild(bottomWall)
    }

    // Left and right walls
    for (let row = 0; row < OFFICE_ROWS; row++) {
      const leftWall = new Sprite(texture)
      leftWall.x = 0
      leftWall.y = row * TILE_SIZE
      this.floorLayer.addChild(leftWall)

      const rightWall = new Sprite(texture)
      rightWall.x = (OFFICE_COLS - 1) * TILE_SIZE
      rightWall.y = row * TILE_SIZE
      this.floorLayer.addChild(rightWall)
    }
  }

  private drawFurniture() {
    for (const item of FURNITURE_POSITIONS) {
      const canvas = generateFurnitureSprite(item.type)
      const texture = Texture.from(canvas)
      const sprite = new Sprite(texture)
      sprite.x = item.col * TILE_SIZE
      sprite.y = item.row * TILE_SIZE
      this.furnitureLayer.addChild(sprite)
    }
  }

  private createDesks() {
    for (const desk of DESK_POSITIONS) {
      // Desk
      const deskCanvas = generateFurnitureSprite("desk")
      const deskTexture = Texture.from(deskCanvas)
      const deskSprite = new Sprite(deskTexture)
      deskSprite.x = desk.col * TILE_SIZE
      deskSprite.y = desk.row * TILE_SIZE
      this.furnitureLayer.addChild(deskSprite)

      // Monitor on desk
      const monitorCanvas = generateFurnitureSprite("monitor")
      const monitorTexture = Texture.from(monitorCanvas)
      const monitorSprite = new Sprite(monitorTexture)
      monitorSprite.x = desk.col * TILE_SIZE
      monitorSprite.y = (desk.row - 1) * TILE_SIZE
      this.furnitureLayer.addChild(monitorSprite)

      // Chair below desk
      const chairCanvas = generateFurnitureSprite("chair")
      const chairTexture = Texture.from(chairCanvas)
      const chairSprite = new Sprite(chairTexture)
      chairSprite.x = desk.col * TILE_SIZE
      chairSprite.y = (desk.row + 1) * TILE_SIZE
      this.furnitureLayer.addChild(chairSprite)

      // Label
      const label = new Text({
        text: desk.label,
        style: new TextStyle({
          fontFamily: "monospace",
          fontSize: 8,
          fill: 0x888888,
        }),
      })
      label.x = desk.col * TILE_SIZE + 2
      label.y = (desk.row + 2) * TILE_SIZE + 4
      this.uiLayer.addChild(label)
    }
  }

  private createCharacters() {
    for (let i = 0; i < AGENT_TYPES.length; i++) {
      const agentType = AGENT_TYPES[i]
      const desk = DESK_POSITIONS[i]

      const character = new AgentCharacter(agentType)
      character.setPosition(desk.col * TILE_SIZE, (desk.row + 1) * TILE_SIZE)
      this.characterLayer.addChild(character.container)
      this.characters.set(agentType, character)

      const bubble = new IssueBubble()
      bubble.setPosition(desk.col * TILE_SIZE - 4, (desk.row - 2) * TILE_SIZE)
      this.uiLayer.addChild(bubble.container)
      this.bubbles.set(agentType, bubble)
    }
  }

  updateState(state: OrchestratorState) {
    if (!this.initialized) return

    const agentType = state.config.agentType

    // Reset all characters to idle
    for (const [type, character] of this.characters) {
      character.setStatus("idle")
      this.bubbles.get(type)?.hide()
    }

    // Update active workspaces
    for (const workspace of state.activeWorkspaces) {
      const character = this.characters.get(agentType)
      const bubble = this.bubbles.get(agentType)

      if (character) {
        character.setStatus(workspace.status)
      }
      if (bubble) {
        bubble.show(workspace.key, workspace.status)
      }
    }
  }

  destroy() {
    this.app.destroy(true)
    this.initialized = false
  }

  get view() {
    return this.app.canvas
  }
}
