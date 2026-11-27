import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parallelBuildJobsEnvironment } from "./parallel-build-env"

const dirs: string[] = []

async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "av-parallel-build-env-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("parallelBuildJobsEnvironment", () => {
  it("caps Cargo, Go, CMake, and Python/uv parallelism based on matching manifests", async () => {
    const rust = await makeWorkspace()
    await writeFile(join(rust, "Cargo.toml"), "[workspace]\n")
    expect(await parallelBuildJobsEnvironment(rust, 3, {}, 8)).toEqual({ CARGO_BUILD_JOBS: "2" })

    const go = await makeWorkspace()
    await writeFile(join(go, "go.mod"), "module example.com/app\n")
    expect(await parallelBuildJobsEnvironment(go, 2, {}, 8)).toEqual({ GOMAXPROCS: "4" })

    const cmake = await makeWorkspace()
    await writeFile(join(cmake, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.20)\n")
    expect(await parallelBuildJobsEnvironment(cmake, 3, {}, 16)).toEqual({ CMAKE_BUILD_PARALLEL_LEVEL: "5" })

    const pyProject = await makeWorkspace()
    await writeFile(join(pyProject, "pyproject.toml"), "[project]\nname='app'\n")
    expect(await parallelBuildJobsEnvironment(pyProject, 4, {}, 2)).toEqual({ UV_CONCURRENT_BUILDS: "1" })

    const uvLock = await makeWorkspace()
    await writeFile(join(uvLock, "uv.lock"), "version = 1\n")
    expect(await parallelBuildJobsEnvironment(uvLock, 2, {}, 6)).toEqual({ UV_CONCURRENT_BUILDS: "3" })
  })

  it("sets all matching caps in a polyglot workspace", async () => {
    const polyglot = await makeWorkspace()
    await Promise.all([
      writeFile(join(polyglot, "Cargo.toml"), "[workspace]\n"),
      writeFile(join(polyglot, "go.mod"), "module example.com/poly\n"),
      writeFile(join(polyglot, "CMakeLists.txt"), "project(poly)\n"),
      writeFile(join(polyglot, "pyproject.toml"), "[project]\nname='poly'\n"),
    ])

    expect(await parallelBuildJobsEnvironment(polyglot, 3, {}, 12)).toEqual({
      CARGO_BUILD_JOBS: "4",
      GOMAXPROCS: "4",
      CMAKE_BUILD_PARALLEL_LEVEL: "4",
      UV_CONCURRENT_BUILDS: "4",
    })
  })

  it("returns empty for serial runs, invalid parallelSlots, or workspaces without manifests", async () => {
    const ws = await makeWorkspace()
    expect(await parallelBuildJobsEnvironment(ws, 3, {}, 8)).toEqual({})

    await mkdir(join(ws, "go.mod")) // directory, not a file -> ignored
    expect(await parallelBuildJobsEnvironment(ws, 3, {}, 8)).toEqual({})

    await writeFile(join(ws, "Cargo.toml"), "[workspace]\n")
    for (const slots of [undefined, 0, 1, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await parallelBuildJobsEnvironment(ws, slots, {}, 8)).toEqual({})
    }
  })

  it("never overrides explicit operator env vars while still capping unset ones", async () => {
    const polyglot = await makeWorkspace()
    await Promise.all([
      writeFile(join(polyglot, "Cargo.toml"), "[workspace]\n"),
      writeFile(join(polyglot, "go.mod"), "module example.com/poly\n"),
      writeFile(join(polyglot, "CMakeLists.txt"), "project(poly)\n"),
      writeFile(join(polyglot, "uv.lock"), "version = 1\n"),
    ])

    expect(
      await parallelBuildJobsEnvironment(
        polyglot,
        3,
        {
          CARGO_BUILD_JOBS: "6",
          GOMAXPROCS: "",
        },
        8,
      ),
    ).toEqual({
      CMAKE_BUILD_PARALLEL_LEVEL: "2",
      UV_CONCURRENT_BUILDS: "2",
    })

    expect(
      await parallelBuildJobsEnvironment(
        polyglot,
        3,
        {
          CARGO_BUILD_JOBS: "6",
          GOMAXPROCS: "6",
          CMAKE_BUILD_PARALLEL_LEVEL: "6",
          UV_CONCURRENT_BUILDS: "6",
        },
        8,
      ),
    ).toEqual({})
  })
})
