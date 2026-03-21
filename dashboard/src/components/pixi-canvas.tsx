"use client"

import { useEffect, useRef, useState } from "react"
import { useSize } from "ahooks"
import { OfficeScene } from "@/lib/canvas/office-scene"
import { computeLayout } from "@/features/office/utils/office-layout"
import type { OrchestratorState } from "@/features/office/types/agent"

interface PixiCanvasProps {
  state: OrchestratorState | null
}

export function PixiCanvas({ state }: PixiCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef<OfficeScene | null>(null)
  const pendingStateRef = useRef<OrchestratorState | null>(null)
  const size = useSize(containerRef)
  const [dimensions, setDimensions] = useState({ width: 512, height: 384 })

  // Create Pixi app once (W-1: flush pending state after init)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let cancelled = false
    const scene = new OfficeScene()

    scene.init(canvas).then(() => {
      if (cancelled) {
        scene.destroy()
        return
      }
      sceneRef.current = scene
      // Flush any state that arrived during init
      const pending = pendingStateRef.current
      if (pending) {
        scene.updateState(pending)
        setDimensions(scene.dimensions)
        pendingStateRef.current = null
      }
    })

    return () => {
      cancelled = true
      sceneRef.current?.destroy()
      sceneRef.current = null
    }
  }, [])

  // Push state updates
  useEffect(() => {
    if (!state) return

    if (sceneRef.current) {
      sceneRef.current.updateState(state)
      setDimensions(sceneRef.current.dimensions)
    } else {
      // Scene not ready yet — stash for later
      pendingStateRef.current = state
    }
  }, [state])

  const slotCount = state?.config.maxParallel ?? 3
  const layout = computeLayout(slotCount)
  const scale = size
    ? Math.min(size.width / dimensions.width, (size.height || 600) / dimensions.height, 3)
    : 1

  return (
    <div ref={containerRef} className="flex items-center justify-center w-full h-full">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Office dashboard: ${state?.activeAgents ?? 0} agents active`}
        style={{
          width: dimensions.width * scale,
          height: dimensions.height * scale,
          imageRendering: "pixelated",
        }}
      />
    </div>
  )
}
