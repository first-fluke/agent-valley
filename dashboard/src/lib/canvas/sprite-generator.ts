import { Texture } from "pixi.js"
import type { AgentType, CharacterSkin, WorkspaceStatus } from "@/features/office/types/agent"

const SPRITE_SIZE = 32

const AGENT_COLORS: Record<AgentType, { primary: string; secondary: string }> = {
  claude: { primary: "#E87B35", secondary: "#2D1B00" },
  codex: { primary: "#10A37F", secondary: "#1A1A2E" },
  gemini: { primary: "#4285F4", secondary: "#A142F4" },
}

function createCanvas(): OffscreenCanvas {
  return new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE)
}

// ── Body ──

function drawBody(
  ctx: OffscreenCanvasRenderingContext2D,
  primary: string,
  secondary: string,
) {
  ctx.fillStyle = "#FFD5B8"
  ctx.fillRect(12, 4, 8, 8)
  ctx.fillStyle = primary
  ctx.fillRect(10, 12, 12, 10)
  ctx.fillStyle = primary
  ctx.fillRect(6, 14, 4, 8)
  ctx.fillRect(22, 14, 4, 8)
  ctx.fillStyle = secondary
  ctx.fillRect(12, 22, 4, 6)
  ctx.fillRect(18, 22, 4, 6)
}

function drawWalkingBody(
  ctx: OffscreenCanvasRenderingContext2D,
  primary: string,
  secondary: string,
  frame: number,
) {
  ctx.fillStyle = "#FFD5B8"
  ctx.fillRect(12, 4, 8, 8)
  ctx.fillStyle = primary
  ctx.fillRect(10, 12, 12, 10)
  const swing = frame % 2 === 0 ? -1 : 1
  ctx.fillStyle = primary
  ctx.fillRect(6, 14 + swing, 4, 8)
  ctx.fillRect(22, 14 - swing, 4, 8)
  ctx.fillStyle = secondary
  const step = frame % 4
  if (step === 0 || step === 2) {
    const leftY = step === 0 ? 20 : 24
    const rightY = step === 0 ? 24 : 20
    ctx.fillRect(12, leftY, 4, 6)
    ctx.fillRect(18, rightY, 4, 6)
  } else {
    ctx.fillRect(12, 22, 4, 6)
    ctx.fillRect(18, 22, 4, 6)
  }
}

// ── Agent-type features (skin="default") ──

function drawClaudeFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = "#E87B35"
  ctx.fillRect(10, 2, 12, 4)
  ctx.fillRect(8, 4, 4, 6)
  ctx.fillRect(20, 4, 4, 6)
  ctx.fillStyle = "#333"
  ctx.fillRect(8, 6, 2, 4)
  ctx.fillRect(22, 6, 2, 4)
  ctx.fillRect(8, 4, 16, 2)
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(14, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
}

function drawCodexFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = "#C0C0C0"
  ctx.fillRect(12, 4, 8, 8)
  ctx.fillStyle = "#10A37F"
  ctx.fillRect(12, 6, 8, 3)
  ctx.fillStyle = "#10A37F"
  ctx.fillRect(15, 1, 2, 3)
  ctx.fillRect(14, 0, 4, 2)
}

function drawGeminiFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  ctx.fillStyle = "#4285F4"
  ctx.fillRect(12, 2, 4, 4)
  ctx.fillStyle = "#A142F4"
  ctx.fillRect(16, 2, 4, 4)
  ctx.fillStyle = "#FFD700"
  ctx.fillRect(15, 0, 2, 2)
  ctx.fillRect(14, 1, 4, 1)
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
}

// ── Character skins ──

function drawDefaultSkin(ctx: OffscreenCanvasRenderingContext2D, agentType: AgentType) {
  switch (agentType) {
    case "claude": drawClaudeFeatures(ctx); break
    case "codex": drawCodexFeatures(ctx); break
    case "gemini": drawGeminiFeatures(ctx); break
  }
}

function drawPonytailSkin(ctx: OffscreenCanvasRenderingContext2D, primary: string) {
  ctx.fillStyle = "#8B4513"
  ctx.fillRect(10, 2, 12, 5)
  ctx.fillRect(22, 4, 3, 10)
  ctx.fillStyle = primary
  ctx.fillRect(22, 7, 3, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(13, 6, 2, 1)
  ctx.fillRect(18, 6, 2, 1)
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(14, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
  ctx.fillStyle = primary
  ctx.fillRect(10, 9, 2, 2)
}

function drawPlumberSkin(ctx: OffscreenCanvasRenderingContext2D, primary: string) {
  ctx.fillStyle = primary
  ctx.fillRect(10, 1, 12, 4)
  ctx.fillRect(8, 5, 16, 2)
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(14, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
  ctx.fillStyle = "#FFB89E"
  ctx.fillRect(15, 8, 2, 2)
  ctx.fillStyle = "#4A2800"
  ctx.fillRect(12, 10, 3, 2)
  ctx.fillRect(17, 10, 3, 2)
  ctx.fillRect(15, 10, 2, 1)
}

function drawGlassesSkin(ctx: OffscreenCanvasRenderingContext2D, primary: string) {
  ctx.fillStyle = "#333"
  ctx.fillRect(11, 2, 10, 3)
  ctx.fillStyle = primary
  ctx.fillRect(11, 6, 5, 4)
  ctx.fillRect(17, 6, 5, 4)
  ctx.fillStyle = "#CCE5FF"
  ctx.fillRect(12, 7, 3, 2)
  ctx.fillRect(18, 7, 3, 2)
  ctx.fillStyle = primary
  ctx.fillRect(16, 7, 1, 1)
  ctx.fillStyle = "#333"
  ctx.fillRect(13, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
}

function drawMohawkSkin(ctx: OffscreenCanvasRenderingContext2D, primary: string) {
  ctx.fillStyle = primary
  ctx.fillRect(14, 0, 4, 5)
  ctx.fillRect(15, -1, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(10, 5, 2, 4)
  ctx.fillRect(20, 5, 2, 4)
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(13, 7, 2, 1)
  ctx.fillRect(18, 7, 2, 1)
  ctx.fillRect(14, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
  ctx.fillStyle = "#FFD700"
  ctx.fillRect(9, 8, 1, 2)
}

function drawSkinFeatures(
  ctx: OffscreenCanvasRenderingContext2D,
  skin: CharacterSkin,
  agentType: AgentType,
  primary: string,
) {
  switch (skin) {
    case "default": drawDefaultSkin(ctx, agentType); break
    case "ponytail": drawPonytailSkin(ctx, primary); break
    case "plumber": drawPlumberSkin(ctx, primary); break
    case "glasses": drawGlassesSkin(ctx, primary); break
    case "mohawk": drawMohawkSkin(ctx, primary); break
  }
}

// ── Status overlay ──

function drawStatusOverlay(
  ctx: OffscreenCanvasRenderingContext2D,
  status: WorkspaceStatus,
  frame: number,
) {
  switch (status) {
    case "idle": {
      const yOffset = frame % 2 === 0 ? 0 : -1
      ctx.fillStyle = "#8B4513"
      ctx.fillRect(24, 16 + yOffset, 4, 5)
      ctx.fillStyle = "#FFF"
      ctx.fillRect(25, 17 + yOffset, 2, 3)
      break
    }
    case "running": {
      const leftArm = [0, -2, 0, 2][frame % 4]
      const rightArm = [2, 0, -2, 0][frame % 4]
      ctx.fillStyle = "#FFD5B8"
      ctx.fillRect(7, 18 + leftArm, 3, 3)
      ctx.fillRect(22, 18 + rightArm, 3, 3)
      break
    }
    case "done": {
      ctx.fillStyle = "#FFD5B8"
      ctx.fillRect(6, 8, 4, 2)
      ctx.fillRect(22, 8, 4, 2)
      if (frame % 3 !== 2) {
        ctx.fillStyle = "#FFD700"
        ctx.fillRect(4, 2, 2, 2)
        ctx.fillRect(26, 4, 2, 2)
      }
      break
    }
    case "failed": {
      ctx.fillStyle = "#FF4444"
      ctx.fillRect(15, 0, 2, 4)
      ctx.fillRect(15, 5, 2, 2)
      if (frame % 2 === 0) {
        ctx.fillStyle = "#FFD5B8"
        ctx.fillRect(20, 4, 3, 3)
      }
      break
    }
  }
}

// ── Texture cache (B-1 fix) ──

const textureCache = new Map<string, Texture>()

export function getAgentTexture(
  agentType: AgentType,
  status: WorkspaceStatus,
  frame: number,
  isWalking: boolean,
  skin: CharacterSkin,
): Texture {
  const key = `${agentType}-${skin}-${status}-${frame}-${isWalking}`
  let texture = textureCache.get(key)
  if (!texture) {
    const canvas = generateAgentSprite(agentType, status, frame, isWalking, skin)
    texture = Texture.from(canvas)
    textureCache.set(key, texture)
  }
  return texture
}

function generateAgentSprite(
  agentType: AgentType,
  status: WorkspaceStatus,
  frame: number,
  isWalking: boolean,
  skin: CharacterSkin,
): OffscreenCanvas {
  const canvas = createCanvas()
  const ctx = canvas.getContext("2d")!
  const colors = AGENT_COLORS[agentType]

  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)

  if (isWalking) {
    drawWalkingBody(ctx, colors.primary, colors.secondary, frame)
  } else {
    drawBody(ctx, colors.primary, colors.secondary)
  }

  drawSkinFeatures(ctx, skin, agentType, colors.primary)

  if (!isWalking) {
    drawStatusOverlay(ctx, status, frame)
  }

  return canvas
}

const furnitureTextureCache = new Map<string, Texture>()

export function getFurnitureTexture(
  type: "desk" | "chair" | "monitor" | "coffee_machine" | "plant" | "server_rack" | "bathroom" | "gym" | "floor" | "wall",
): Texture {
  let texture = furnitureTextureCache.get(type)
  if (!texture) {
    const canvas = generateFurnitureSprite(type)
    texture = Texture.from(canvas)
    furnitureTextureCache.set(type, texture)
  }
  return texture
}

function generateFurnitureSprite(
  type: "desk" | "chair" | "monitor" | "coffee_machine" | "plant" | "server_rack" | "bathroom" | "gym" | "floor" | "wall",
): OffscreenCanvas {
  const canvas = createCanvas()
  const ctx = canvas.getContext("2d")!
  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)

  switch (type) {
    case "floor":
      ctx.fillStyle = "#2A2A3E"
      ctx.fillRect(0, 0, 32, 32)
      ctx.fillStyle = "#323248"
      ctx.fillRect(0, 0, 16, 16)
      ctx.fillRect(16, 16, 16, 16)
      break
    case "wall":
      ctx.fillStyle = "#3A3A52"
      ctx.fillRect(0, 0, 32, 32)
      ctx.fillStyle = "#44445E"
      ctx.fillRect(2, 2, 28, 28)
      break
    case "desk":
      ctx.fillStyle = "#8B6914"
      ctx.fillRect(2, 8, 28, 4)
      ctx.fillRect(4, 12, 4, 16)
      ctx.fillRect(24, 12, 4, 16)
      break
    case "monitor":
      ctx.fillStyle = "#333"
      ctx.fillRect(8, 0, 16, 12)
      ctx.fillStyle = "#1A1A2E"
      ctx.fillRect(10, 1, 12, 9)
      ctx.fillStyle = "#333"
      ctx.fillRect(14, 12, 4, 3)
      ctx.fillRect(10, 15, 12, 2)
      break
    case "chair":
      ctx.fillStyle = "#444"
      ctx.fillRect(8, 4, 16, 12)
      ctx.fillStyle = "#555"
      ctx.fillRect(10, 16, 12, 4)
      ctx.fillRect(14, 20, 4, 8)
      break
    case "coffee_machine":
      ctx.fillStyle = "#666"
      ctx.fillRect(8, 4, 16, 20)
      ctx.fillStyle = "#8B4513"
      ctx.fillRect(12, 8, 8, 6)
      ctx.fillStyle = "#FF6347"
      ctx.fillRect(20, 6, 3, 3)
      break
    case "plant":
      ctx.fillStyle = "#8B4513"
      ctx.fillRect(12, 20, 8, 8)
      ctx.fillStyle = "#228B22"
      ctx.fillRect(10, 8, 12, 14)
      ctx.fillStyle = "#32CD32"
      ctx.fillRect(8, 4, 6, 8)
      ctx.fillRect(18, 6, 6, 6)
      break
    case "server_rack":
      ctx.fillStyle = "#1A1A2E"
      ctx.fillRect(4, 2, 24, 28)
      ctx.fillStyle = "#333"
      ctx.fillRect(6, 4, 20, 5)
      ctx.fillRect(6, 11, 20, 5)
      ctx.fillRect(6, 18, 20, 5)
      ctx.fillStyle = "#00FF00"
      ctx.fillRect(8, 6, 2, 2)
      ctx.fillRect(8, 13, 2, 2)
      ctx.fillStyle = "#FF4444"
      ctx.fillRect(8, 20, 2, 2)
      break
    case "bathroom":
      ctx.fillStyle = "#EEEEFF"
      ctx.fillRect(4, 12, 10, 12)
      ctx.fillRect(6, 8, 6, 4)
      ctx.fillStyle = "#CCCCDD"
      ctx.fillRect(8, 10, 2, 2)
      ctx.fillStyle = "#DDDDEE"
      ctx.fillRect(18, 14, 10, 6)
      ctx.fillStyle = "#88BBFF"
      ctx.fillRect(20, 15, 6, 4)
      ctx.fillStyle = "#556677"
      ctx.fillRect(20, 4, 6, 8)
      ctx.fillStyle = "#AACCEE"
      ctx.fillRect(21, 5, 4, 6)
      ctx.fillStyle = "#C0C0C0"
      ctx.fillRect(22, 12, 2, 3)
      break
    case "gym":
      ctx.fillStyle = "#555"
      ctx.fillRect(4, 16, 4, 8)
      ctx.fillRect(12, 16, 4, 8)
      ctx.fillStyle = "#888"
      ctx.fillRect(8, 18, 4, 4)
      ctx.fillStyle = "#8B6914"
      ctx.fillRect(18, 18, 12, 4)
      ctx.fillRect(20, 22, 4, 6)
      ctx.fillRect(26, 22, 4, 6)
      ctx.fillStyle = "#444"
      ctx.fillRect(22, 6, 6, 6)
      ctx.fillStyle = "#666"
      ctx.fillRect(23, 7, 4, 4)
      ctx.fillStyle = "#444"
      ctx.fillRect(24, 8, 2, 2)
      break
  }

  return canvas
}

export { SPRITE_SIZE }
