import type { AgentType, WorkspaceStatus } from "@/features/office/types/agent"

const SPRITE_SIZE = 32

const AGENT_COLORS: Record<AgentType, { primary: string; secondary: string }> = {
  claude: { primary: "#E87B35", secondary: "#2D1B00" },
  codex: { primary: "#10A37F", secondary: "#1A1A2E" },
  gemini: { primary: "#4285F4", secondary: "#A142F4" },
}

function createCanvas(): OffscreenCanvas {
  return new OffscreenCanvas(SPRITE_SIZE, SPRITE_SIZE)
}

function drawBody(
  ctx: OffscreenCanvasRenderingContext2D,
  primary: string,
  secondary: string,
) {
  // Head
  ctx.fillStyle = "#FFD5B8"
  ctx.fillRect(12, 4, 8, 8)

  // Body
  ctx.fillStyle = primary
  ctx.fillRect(10, 12, 12, 10)

  // Arms
  ctx.fillStyle = primary
  ctx.fillRect(6, 14, 4, 8)
  ctx.fillRect(22, 14, 4, 8)

  // Legs
  ctx.fillStyle = secondary
  ctx.fillRect(12, 22, 4, 6)
  ctx.fillRect(18, 22, 4, 6)
}

function drawClaudeFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  // Hood
  ctx.fillStyle = "#E87B35"
  ctx.fillRect(10, 2, 12, 4)
  ctx.fillRect(8, 4, 4, 6)
  ctx.fillRect(20, 4, 4, 6)

  // Headset
  ctx.fillStyle = "#333"
  ctx.fillRect(8, 6, 2, 4)
  ctx.fillRect(22, 6, 2, 4)
  ctx.fillRect(8, 4, 16, 2)

  // Eyes
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
  ctx.fillStyle = "#333"
  ctx.fillRect(14, 8, 1, 1)
  ctx.fillRect(19, 8, 1, 1)
}

function drawCodexFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  // Robot head (metallic)
  ctx.fillStyle = "#C0C0C0"
  ctx.fillRect(12, 4, 8, 8)

  // Visor
  ctx.fillStyle = "#10A37F"
  ctx.fillRect(12, 6, 8, 3)

  // Antenna
  ctx.fillStyle = "#10A37F"
  ctx.fillRect(15, 1, 2, 3)
  ctx.fillRect(14, 0, 4, 2)
}

function drawGeminiFeatures(ctx: OffscreenCanvasRenderingContext2D) {
  // Dual-tone head
  ctx.fillStyle = "#4285F4"
  ctx.fillRect(12, 2, 4, 4)
  ctx.fillStyle = "#A142F4"
  ctx.fillRect(16, 2, 4, 4)

  // Star antenna
  ctx.fillStyle = "#FFD700"
  ctx.fillRect(15, 0, 2, 2)
  ctx.fillRect(14, 1, 4, 1)

  // Eyes
  ctx.fillStyle = "#FFF"
  ctx.fillRect(13, 7, 2, 2)
  ctx.fillRect(18, 7, 2, 2)
}

function drawStatusOverlay(
  ctx: OffscreenCanvasRenderingContext2D,
  status: WorkspaceStatus,
  frame: number,
) {
  switch (status) {
    case "idle": {
      // Coffee mug in hand
      const yOffset = frame % 2 === 0 ? 0 : -1
      ctx.fillStyle = "#8B4513"
      ctx.fillRect(24, 16 + yOffset, 4, 5)
      ctx.fillStyle = "#FFF"
      ctx.fillRect(25, 17 + yOffset, 2, 3)
      break
    }
    case "running": {
      // Typing motion — arms move
      const armOffset = frame % 2 === 0 ? -1 : 1
      ctx.fillStyle = "#FFD5B8"
      ctx.fillRect(7, 20 + armOffset, 3, 2)
      ctx.fillRect(22, 20 - armOffset, 3, 2)
      break
    }
    case "done": {
      // Raised arms
      ctx.fillStyle = "#FFD5B8"
      ctx.fillRect(6, 8, 4, 2)
      ctx.fillRect(22, 8, 4, 2)
      // Star sparkle
      if (frame % 3 !== 2) {
        ctx.fillStyle = "#FFD700"
        ctx.fillRect(4, 2, 2, 2)
        ctx.fillRect(26, 4, 2, 2)
      }
      break
    }
    case "failed": {
      // Exclamation mark above head
      ctx.fillStyle = "#FF4444"
      ctx.fillRect(15, 0, 2, 4)
      ctx.fillRect(15, 5, 2, 2)
      // Scratch head
      if (frame % 2 === 0) {
        ctx.fillStyle = "#FFD5B8"
        ctx.fillRect(20, 4, 3, 3)
      }
      break
    }
  }
}

export function generateAgentSprite(
  agentType: AgentType,
  status: WorkspaceStatus,
  frame: number,
): OffscreenCanvas {
  const canvas = createCanvas()
  const ctx = canvas.getContext("2d")!
  const colors = AGENT_COLORS[agentType]

  ctx.clearRect(0, 0, SPRITE_SIZE, SPRITE_SIZE)

  drawBody(ctx, colors.primary, colors.secondary)

  switch (agentType) {
    case "claude":
      drawClaudeFeatures(ctx)
      break
    case "codex":
      drawCodexFeatures(ctx)
      break
    case "gemini":
      drawGeminiFeatures(ctx)
      break
  }

  drawStatusOverlay(ctx, status, frame)

  return canvas
}

export function generateFurnitureSprite(
  type: "desk" | "chair" | "monitor" | "coffee_machine" | "plant" | "server_rack" | "floor" | "wall",
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
      // LEDs
      ctx.fillStyle = "#00FF00"
      ctx.fillRect(8, 6, 2, 2)
      ctx.fillRect(8, 13, 2, 2)
      ctx.fillStyle = "#FF4444"
      ctx.fillRect(8, 20, 2, 2)
      break
  }

  return canvas
}

export { SPRITE_SIZE }
