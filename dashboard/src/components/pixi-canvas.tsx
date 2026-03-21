"use client"

import { useEffect, useRef } from "react"
import { useSize } from "ahooks"
import { OfficeScene } from "@/lib/canvas/office-scene"
import { OFFICE_WIDTH, OFFICE_HEIGHT } from "@/features/office/utils/office-layout"
import type { OrchestratorState } from "@/features/office/types/agent"

interface PixiCanvasProps {
  state: OrchestratorState | null
}

export function PixiCanvas({ state }: PixiCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<OfficeScene | null>(null)
  const size = useSize(containerRef)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const scene = new OfficeScene()
    sceneRef.current = scene
    scene.init(canvas)

    return () => {
      scene.destroy()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    if (state && sceneRef.current) {
      sceneRef.current.updateState(state)
    }
  }, [state])

  const scale = size
    ? Math.min(size.width / OFFICE_WIDTH, (size.height || 600) / OFFICE_HEIGHT, 3)
    : 1

  return (
    <div ref={containerRef} className="flex items-center justify-center w-full h-full">
      <canvas
        ref={canvasRef}
        style={{
          width: OFFICE_WIDTH * scale,
          height: OFFICE_HEIGHT * scale,
          imageRendering: "pixelated",
        }}
      />
    </div>
  )
}
