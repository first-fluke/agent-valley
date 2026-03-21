import { Application, Container, Sprite, Text, TextStyle } from "pixi.js"
import {
  TILE_SIZE,
  OFFICE_ROWS,
  computeLayout,
  type OfficeLayout,
} from "@/features/office/utils/office-layout"
import { getFurnitureTexture } from "@/lib/canvas/sprite-generator"
import { AgentCharacter } from "@/lib/canvas/agent-character"
import { IssueBubble } from "@/lib/canvas/issue-bubble"
import { CHARACTER_SKINS, type AgentType, type CharacterSkin, type OrchestratorState } from "@/features/office/types/agent"

// S-8: Named constants for layout offsets
const MONITOR_Y_OFFSET = -10
const LABEL_Y_OFFSET = 4
const OUTPUT_TEXT_Y_OFFSET = -8
const BUBBLE_Y_ROWS = -2

function pickRandomSkins(count: number): CharacterSkin[] {
  const skins: CharacterSkin[] = []
  for (let i = 0; i < count; i++) {
    skins.push(CHARACTER_SKINS[Math.floor(Math.random() * CHARACTER_SKINS.length)])
  }
  return skins
}

export class OfficeScene {
  private app: Application
  private floorLayer: Container
  private furnitureLayer: Container
  private characterLayer: Container
  private uiLayer: Container
  private characters: Map<number, AgentCharacter> = new Map()
  private bubbles: Map<number, IssueBubble> = new Map()
  private deskLabels: Map<number, Text> = new Map()
  private outputTexts: Map<number, Text> = new Map()
  private currentAgentType: AgentType = "claude"
  private currentSlotCount = 0
  private layout: OfficeLayout | null = null
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
      width: 512,
      height: OFFICE_ROWS * TILE_SIZE,
      backgroundColor: 0x1a1a2e,
      antialias: false,
      resolution: 2,
      autoDensity: true,
    })

    this.app.stage.addChild(this.floorLayer)
    this.app.stage.addChild(this.furnitureLayer)
    this.app.stage.addChild(this.characterLayer)
    this.app.stage.addChild(this.uiLayer)

    this.initialized = true
  }

  private clearLayers() {
    for (const [, character] of this.characters) character.destroy()
    for (const [, bubble] of this.bubbles) bubble.destroy()
    this.characters.clear()
    this.bubbles.clear()
    this.deskLabels.clear()
    this.outputTexts.clear()
    this.floorLayer.removeChildren()
    this.furnitureLayer.removeChildren()
    this.characterLayer.removeChildren()
    this.uiLayer.removeChildren()
  }

  private rebuildLayout(slotCount: number) {
    this.clearLayers()

    this.layout = computeLayout(slotCount)
    this.currentSlotCount = slotCount

    this.app.renderer.resize(this.layout.width, this.layout.height)

    this.drawFloor()
    this.drawWalls()
    this.drawFurniture()
    this.createDesks()
    this.createCharacters()
  }

  private drawFloor() {
    const { cols } = this.layout!
    const texture = getFurnitureTexture("floor")

    for (let row = 2; row < OFFICE_ROWS - 1; row++) {
      for (let col = 1; col < cols - 1; col++) {
        const sprite = new Sprite(texture)
        sprite.x = col * TILE_SIZE
        sprite.y = row * TILE_SIZE
        this.floorLayer.addChild(sprite)
      }
    }
  }

  private drawWalls() {
    const { cols } = this.layout!
    const texture = getFurnitureTexture("wall")

    for (let col = 0; col < cols; col++) {
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

    for (let row = 0; row < OFFICE_ROWS; row++) {
      const leftWall = new Sprite(texture)
      leftWall.x = 0
      leftWall.y = row * TILE_SIZE
      this.floorLayer.addChild(leftWall)

      const rightWall = new Sprite(texture)
      rightWall.x = (cols - 1) * TILE_SIZE
      rightWall.y = row * TILE_SIZE
      this.floorLayer.addChild(rightWall)
    }
  }

  private drawFurniture() {
    for (const item of this.layout!.furniture) {
      const texture = getFurnitureTexture(item.type)
      const sprite = new Sprite(texture)
      sprite.x = item.col * TILE_SIZE
      sprite.y = item.row * TILE_SIZE
      this.furnitureLayer.addChild(sprite)
    }
  }

  private createDesks() {
    const { desks } = this.layout!

    for (let i = 0; i < desks.length; i++) {
      const desk = desks[i]

      const deskSprite = new Sprite(getFurnitureTexture("desk"))
      deskSprite.x = desk.col * TILE_SIZE
      deskSprite.y = desk.row * TILE_SIZE
      this.furnitureLayer.addChild(deskSprite)

      const monitorSprite = new Sprite(getFurnitureTexture("monitor"))
      monitorSprite.x = desk.col * TILE_SIZE
      monitorSprite.y = desk.row * TILE_SIZE + MONITOR_Y_OFFSET
      this.furnitureLayer.addChild(monitorSprite)

      const chairSprite = new Sprite(getFurnitureTexture("chair"))
      chairSprite.x = desk.col * TILE_SIZE
      chairSprite.y = (desk.row + 1) * TILE_SIZE
      this.furnitureLayer.addChild(chairSprite)

      const label = new Text({
        text: desk.label,
        style: new TextStyle({
          fontFamily: "monospace",
          fontSize: 8,
          fill: 0x888888,
        }),
      })
      label.x = desk.col * TILE_SIZE + 2
      label.y = (desk.row + 2) * TILE_SIZE + LABEL_Y_OFFSET
      this.uiLayer.addChild(label)
      this.deskLabels.set(i, label)

      const outputText = new Text({
        text: "",
        style: new TextStyle({
          fontFamily: "monospace",
          fontSize: 5,
          fill: 0x44ff44,
          wordWrap: true,
          wordWrapWidth: 36,
        }),
      })
      outputText.x = desk.col * TILE_SIZE + 2
      outputText.y = desk.row * TILE_SIZE + OUTPUT_TEXT_Y_OFFSET
      outputText.visible = false
      this.uiLayer.addChild(outputText)
      this.outputTexts.set(i, outputText)
    }
  }

  private createCharacters() {
    const { desks, walkableTiles, interestPoints } = this.layout!
    const skins = pickRandomSkins(desks.length)

    for (let i = 0; i < desks.length; i++) {
      const desk = desks[i]

      const character = new AgentCharacter(
        this.currentAgentType,
        skins[i],
        walkableTiles,
        interestPoints,
        this.app.ticker,
      )
      character.setPosition(desk.col * TILE_SIZE, (desk.row + 1) * TILE_SIZE)
      this.characterLayer.addChild(character.container)
      this.characters.set(i, character)

      const bubble = new IssueBubble()
      bubble.setPosition(desk.col * TILE_SIZE - 4, (desk.row + BUBBLE_Y_ROWS) * TILE_SIZE)
      this.uiLayer.addChild(bubble.container)
      this.bubbles.set(i, bubble)
    }
  }

  updateState(state: OrchestratorState) {
    if (!this.initialized) return

    const newSlotCount = state.config.maxParallel
    if (newSlotCount !== this.currentSlotCount) {
      this.rebuildLayout(newSlotCount)
    }

    const agentType = state.config.agentType
    const slotCount = this.currentSlotCount

    if (this.currentAgentType !== agentType) {
      this.currentAgentType = agentType
      for (const [, character] of this.characters) {
        character.setAgentType(agentType)
      }
    }

    const agentName = agentType.charAt(0).toUpperCase() + agentType.slice(1)
    for (let i = 0; i < slotCount; i++) {
      const label = this.deskLabels.get(i)
      if (label) label.text = `${agentName} #${i + 1}`
    }

    // W-4 fix: assign active slots first, then idle the rest (avoid double status transition)
    const activeSlots = new Set<number>()
    for (let i = 0; i < state.activeWorkspaces.length && i < slotCount; i++) {
      activeSlots.add(i)
      const workspace = state.activeWorkspaces[i]
      const character = this.characters.get(i)
      const bubble = this.bubbles.get(i)
      const outputText = this.outputTexts.get(i)

      if (character) character.setStatus(workspace.status)
      if (bubble) bubble.show(workspace.key, workspace.status)
      if (outputText && workspace.lastOutput && workspace.status === "running") {
        outputText.text = workspace.lastOutput
        outputText.visible = true
      } else if (outputText) {
        outputText.visible = false
      }
    }

    for (let i = 0; i < slotCount; i++) {
      if (activeSlots.has(i)) continue
      this.characters.get(i)?.setStatus("idle")
      this.bubbles.get(i)?.hide()
      const outputText = this.outputTexts.get(i)
      if (outputText) outputText.visible = false
    }
  }

  get dimensions() {
    return this.layout
      ? { width: this.layout.width, height: this.layout.height }
      : { width: 512, height: OFFICE_ROWS * TILE_SIZE }
  }

  destroy() {
    this.clearLayers()
    if (this.initialized) {
      this.app.destroy(true)
    }
    this.initialized = false
    this.layout = null
  }

  get view() {
    return this.app.canvas
  }
}
