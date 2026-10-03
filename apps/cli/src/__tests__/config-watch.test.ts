import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveProjectConfigPath } from "@agent-valley/core/config/project-config-path"
import { loadProjectConfig } from "@agent-valley/core/config/yaml-loader"
import { expect, it, vi } from "vitest"
import { watchConfig } from "../config-watch"

it("watches av.yaml and global settings while ignoring valley.yaml events", async () => {
  const root = await mkdtemp(join(tmpdir(), "av-config-watch-"))
  const canonical = join(root, "av.yaml")
  const ignored = join(root, "valley.yaml")
  const global = join(root, "settings.yaml")
  let notify: ((path: string) => void) | undefined
  const changes = vi.fn()
  const watcher = await watchConfig(root, global, (path) => {
    changes(path)
    notify?.(path)
  })
  await new Promise<void>((resolveReady) => watcher.once("ready", () => resolveReady()))
  const changed = async (path: string, action: () => Promise<unknown>) => {
    const event = new Promise<void>((resolveEvent, reject) => {
      const timer = setTimeout(() => reject(new Error("Config change event did not arrive.")), 2_000)
      notify = (actual) => {
        if (actual === path) {
          clearTimeout(timer)
          resolveEvent()
        }
      }
    })
    await action()
    await event
  }
  const ignoredChange = async (action: () => Promise<unknown>) => {
    const previous = changes.mock.calls.length
    await action()
    await new Promise((resolveQuiet) => setTimeout(resolveQuiet, 100))
    expect(changes).toHaveBeenCalledTimes(previous)
  }
  try {
    await ignoredChange(() => writeFile(ignored, "actor:\n  type: grok\n"))
    expect(resolveProjectConfigPath(root)).toBe(canonical)
    expect(loadProjectConfig(root)).toBeNull()
    await ignoredChange(() => writeFile(ignored, "actor:\n  type: codex\n"))
    await ignoredChange(() => rm(ignored))
    await changed(canonical, () => writeFile(canonical, "actor:\n  type: cursor\n"))
    expect(loadProjectConfig(root)?.agent?.type).toBe("cursor")
    await changed(canonical, () => writeFile(canonical, "actor:\n  type: codex\n"))
    expect(loadProjectConfig(root)?.agent?.type).toBe("codex")
    await changed(canonical, () => rm(canonical))
    expect(resolveProjectConfigPath(root)).toBe(canonical)
    expect(loadProjectConfig(root)).toBeNull()
    await changed(global, () => writeFile(global, "actor:\n  type: kimi\n"))
    expect(changes.mock.calls.flat()).not.toContain(ignored)
  } finally {
    await watcher.close()
    await rm(root, { recursive: true, force: true })
  }
}, 10_000)
