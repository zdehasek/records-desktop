import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MIME_TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "text/javascript",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
}

export async function startBackendFixture(root) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-browser-"))
  const configHome = path.join(directory, "config")
  const dataHome = path.join(directory, "data")
  const cacheHome = path.join(directory, "cache")
  const profileData = path.join(dataHome, "records", "profiles", "production")
  const mediaFolder = path.join(profileData, "media")
  const watchedFolder = path.join(directory, "watched")
  const configFolder = path.join(
    configHome,
    "records",
    "profiles",
    "production"
  )
  const frontendDirectory = path.join(directory, "frontend")
  const fixtureBin = path.join(directory, "bin")

  for (const target of [mediaFolder, watchedFolder, configFolder, fixtureBin]) {
    fs.mkdirSync(target, { recursive: true })
  }

  const gioPath = path.join(fixtureBin, "gio")
  fs.writeFileSync(
    gioPath,
    '#!/bin/sh\n[ "$1" = "trash" ] || exit 1\nrm -rf -- "$2"\n'
  )
  fs.chmodSync(gioPath, 0o700)

  fs.writeFileSync(
    path.join(configFolder, "config.yaml"),
    [
      "version: 4",
      "profile:",
      "  name: Production",
      "media:",
      "  roots:",
      "    - name: browser-media",
      `      path: ${JSON.stringify(mediaFolder)}`,
      "      enabled: true",
      "    - name: browser-watch",
      `      path: ${JSON.stringify(watchedFolder)}`,
      "      enabled: true",
      "  defaultRoot: browser-media",
      "preferences: {}",
      ""
    ].join("\n")
  )

  const createImage = (filePath, color, size = "16x16") => {
    const result = spawnSync(
      "magick",
      ["-size", size, `xc:${color}`, filePath],
      { encoding: "utf8" }
    )
    if (result.status !== 0) {
      throw new Error(`fixture image creation failed: ${result.stderr}`)
    }
  }
  createImage(path.join(mediaFolder, "info.jpg"), "#d94f4f", "17x16")
  createImage(path.join(mediaFolder, "duplicate-one.png"), "#4169e1")
  fs.copyFileSync(
    path.join(mediaFolder, "duplicate-one.png"),
    path.join(mediaFolder, "duplicate-two.png")
  )
  createImage(
    path.join(watchedFolder, "watched-startup.png"),
    "#35a853",
    "18x16"
  )
  const videoPath = path.join(mediaFolder, "tone.mp4")
  const video = spawnSync(
    process.env.REC_FFMPEG_PATH || "/usr/bin/ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=blue:s=96x64:r=12:d=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      videoPath
    ],
    { encoding: "utf8" }
  )
  if (video.status !== 0) {
    throw new Error(`fixture video creation failed: ${video.stderr}`)
  }
  fs.writeFileSync(path.join(mediaFolder, "ignored.mp3"), "legacy audio")
  const audioOnly = spawnSync(
    process.env.REC_FFMPEG_PATH || "/usr/bin/ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      path.join(mediaFolder, "audio-only.mp4")
    ],
    { encoding: "utf8" }
  )
  if (audioOnly.status !== 0) {
    throw new Error(`fixture audio creation failed: ${audioOnly.stderr}`)
  }
  const fixtureDate = new Date("2024-04-05T10:30:00Z")
  for (const filePath of [
    path.join(mediaFolder, "duplicate-one.png"),
    path.join(mediaFolder, "duplicate-two.png"),
    path.join(watchedFolder, "watched-startup.png")
  ]) {
    fs.utimesSync(filePath, fixtureDate, fixtureDate)
  }
  const today = new Date()
  fs.utimesSync(path.join(mediaFolder, "info.jpg"), today, today)
  fs.utimesSync(videoPath, today, today)

  const build = spawnSync(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--outDir",
      frontendDirectory,
      "--emptyOutDir"
    ],
    { cwd: root, encoding: "utf8" }
  )
  if (build.status !== 0) {
    throw new Error(`frontend fixture build failed:\n${build.stderr}`)
  }

  const child = spawn(
    process.execPath,
    ["--no-warnings", "runtime/bootstrap.js"],
    {
      cwd: root,
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheHome,
        XDG_CONFIG_HOME: configHome,
        XDG_DATA_HOME: dataHome,
        PATH: `${fixtureBin}${path.delimiter}${process.env.PATH || ""}`,
        RECORDS_CONFIG_PATH: "",
        RECORDS_DB_PATH: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  )

  let errors = ""
  const appUrl = await new Promise((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(() => {
      reject(new Error(`server readiness timed out: ${errors}`))
    }, 20_000)
    child.stderr.on("data", (chunk) => {
      errors += chunk
    })
    child.stdout.on("data", (chunk) => {
      output += chunk
      const line = output
        .split("\n")
        .find((value) => value.startsWith("RECORDS_READY "))
      if (!line) return
      clearTimeout(timeout)
      resolve(JSON.parse(line.slice("RECORDS_READY ".length)).url)
    })
    child.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`server exited ${code}: ${errors}`))
    })
  })

  const rpc = async (method, args = []) => {
    let response
    try {
      response = await fetch(new URL("rpc", appUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ method, args })
      })
    } catch (error) {
      throw new Error(
        `RPC transport failed: backend exit=${child.exitCode} signal=${child.signalCode}\n${errors}`,
        { cause: error }
      )
    }
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error || `RPC failed: ${method}`)
    return payload.result
  }

  const routeFrontend = async (page) => {
    const base = new URL(appUrl)
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url())
      if (
        url.origin !== base.origin ||
        !url.pathname.startsWith(base.pathname)
      ) {
        await route.continue()
        return
      }
      const relativePath = url.pathname.slice(base.pathname.length)
      const requestedPath = relativePath || "index.html"
      const filePath = path.resolve(frontendDirectory, requestedPath)
      const prefix = `${path.resolve(frontendDirectory)}${path.sep}`
      if (
        filePath !== path.join(frontendDirectory, "index.html") &&
        !filePath.startsWith(prefix)
      ) {
        await route.continue()
        return
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        await route.continue()
        return
      }
      await route.fulfill({
        path: filePath,
        contentType:
          MIME_TYPES[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream"
      })
    })
  }

  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve)
        child.kill("SIGTERM")
      })
    }
    fs.rmSync(directory, { recursive: true, force: true })
  }

  return {
    appUrl,
    directory,
    routeFrontend,
    rpc,
    stop,
    watchedFolder
  }
}
