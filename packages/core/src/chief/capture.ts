import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { type CaptureBrowser, connectAsideBrowser } from "./capture-mcp"
import { type CapturePolicy, type CaptureResult, capturePolicySchema, captureResultSchema } from "./capture-schema"
import type { ReportAttachment } from "./report-delivery-contract"

export * from "./capture-schema"
export interface CaptureDependencies {
  connect(repository: string, policy: CapturePolicy): Promise<CaptureBrowser>
  encode(directory: string, manifest: string, output: string): Promise<void>
  now(): Date
}
export function encodeCaptureVideo(directory: string, manifest: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        manifest,
        "-vf",
        "pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        output,
      ],
      { cwd: directory, stdio: "ignore" },
    )
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Video encoding timed out. Reduce chief.capture.max_frames."))
    }, 60_000)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Install ffmpeg with libx264 to attach a video. Captured PNG files remain available."))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else
        reject(
          new Error("ffmpeg could not encode the recording. Check libx264 support; PNG captures remain available."),
        )
    })
  })
}
export class MissionCapture {
  private browser?: CaptureBrowser
  private timer?: ReturnType<typeof setTimeout>
  private pending: Promise<void> = Promise.resolve()
  private stopped = false
  private frameLimitReached = false
  private startedAt: string
  private frames: Array<{ attachment: ReportAttachment; at: string; stage: string }> = []
  private errors: string[] = []
  private stage = "starting"
  readonly directory: string
  private deps: CaptureDependencies
  constructor(
    private repository: string,
    missionId: string,
    private policy: CapturePolicy,
    deps: Partial<CaptureDependencies> = {},
  ) {
    capturePolicySchema.parse(policy)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(missionId))
      throw new Error("Use a safe mission ID for capture artifacts.")
    this.directory = join(repository, ".agent-valley/captures", missionId, randomUUID())
    this.deps = { connect: connectAsideBrowser, encode: encodeCaptureVideo, now: () => new Date(), ...deps }
    this.startedAt = this.deps.now().toISOString()
  }
  label(stage: string): void {
    this.stage = stage.slice(0, 200)
  }
  private error(error: unknown): void {
    if (this.errors.length < 20)
      this.errors.push((error instanceof Error ? error.message : "Capture failed").slice(0, 2_000))
  }
  async start(): Promise<void> {
    if (!this.policy.enabled) return
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      this.browser = await this.deps.connect(this.repository, this.policy)
      await this.frame()
      this.schedule()
    } catch (error) {
      this.error(error)
    }
  }
  private schedule(): void {
    if (this.stopped || !this.browser) return
    if (this.frames.length >= this.policy.maxFrames) {
      this.frameLimitReached = true
      return
    }
    this.timer = setTimeout(() => {
      this.pending = this.frame().finally(() => this.schedule())
    }, this.policy.intervalMs)
  }
  private async attachment(name: string, mimeType: string, bytes?: Buffer): Promise<ReportAttachment> {
    const path = join(this.directory, name)
    if (bytes) await writeFile(path, bytes, { mode: 0o600 })
    const contents = bytes ?? (await readFile(path))
    if (!contents.length || contents.length > 200 * 1024 * 1024)
      throw new Error("Capture artifact must contain bytes and be at most 200 MB.")
    return {
      path,
      name,
      mimeType,
      sizeBytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    }
  }
  private async frame(): Promise<void> {
    if (!this.browser || this.frames.length >= this.policy.maxFrames) return
    try {
      const attachment = await this.attachment(
        `frame-${String(this.frames.length).padStart(4, "0")}.png`,
        "image/png",
        await this.browser.screenshot(),
      )
      this.frames.push({ attachment, at: this.deps.now().toISOString(), stage: this.stage })
    } catch (error) {
      this.error(error)
    }
  }
  async stop(): Promise<CaptureResult> {
    this.stopped = true
    clearTimeout(this.timer)
    await this.pending
    if (this.browser) {
      await this.frame()
      await this.browser.close().catch((error: unknown) => this.error(error))
      this.browser = undefined
    }
    const finishedAt = this.deps.now().toISOString()
    if (this.frameLimitReached)
      this.error(
        new Error(
          `Capture stopped at max_frames=${this.policy.maxFrames}; later activity was not recorded. Increase chief.capture.max_frames for longer captures.`,
        ),
      )
    const attachments = this.frames.map((frame) => frame.attachment)
    if (this.frames.length) {
      const manifest = JSON.stringify(
        {
          startedAt: this.startedAt,
          finishedAt,
          cadence: "periodic screenshots; video does not record audio",
          frameLimitReached: this.frameLimitReached,
          capturedUntil: this.frames.at(-1)?.at,
          frames: this.frames.map(({ attachment, ...frame }) => ({
            ...frame,
            name: attachment.name,
            sha256: attachment.sha256,
          })),
        },
        null,
        2,
      )
      try {
        attachments.push(await this.attachment("capture.json", "application/json", Buffer.from(manifest)))
      } catch (error) {
        this.error(error)
      }
      if (this.policy.video) {
        try {
          const concat = `${this.frames
            .map((frame, index) => {
              const end = this.frames[index + 1]?.at ?? finishedAt
              const observed = (Date.parse(end) - Date.parse(frame.at)) / 1000
              const duration = Math.max(
                0.1,
                this.frameLimitReached && index === this.frames.length - 1
                  ? Math.min(observed, this.policy.intervalMs / 1000)
                  : observed,
              )
              return `file '${frame.attachment.name}'\nduration ${duration}`
            })
            .join("\n")}\nfile '${this.frames.at(-1)?.attachment.name}'\n`
          const manifestPath = join(this.directory, "frames.txt")
          const output = join(this.directory, "recording.mp4")
          await writeFile(manifestPath, concat, { mode: 0o600 })
          await this.deps.encode(this.directory, manifestPath, output)
          await chmod(output, 0o600)
          const video = await this.attachment("recording.mp4", "video/mp4")
          attachments.push(video)
        } catch (error) {
          this.error(error)
        }
      }
    }
    return captureResultSchema.parse({
      status: !this.frames.length ? "failed" : this.errors.length ? "partial" : "completed",
      startedAt: this.startedAt,
      finishedAt,
      frames: this.frames.length,
      attachments,
      errors: this.errors,
    })
  }
}
