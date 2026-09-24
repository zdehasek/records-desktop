import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { findCommand, runCommand } from "./host-tools.js"

const PLATFORM_METHODS = [
  "chooseFile",
  "chooseFolder",
  "moveToTrash",
  "openFile",
  "revealFile",
  "sendNotification",
  "resolveHostTool",
  "configDirectory",
  "dataDirectory",
  "cacheDirectory",
  "requestRestart",
  "capabilities"
]

function assertPlatform(platform) {
  for (const method of PLATFORM_METHODS) {
    if (typeof platform[method] !== "function") {
      throw new Error(`Runtime platform is missing ${method}()`)
    }
  }
  return Object.freeze(platform)
}

function xdgRoot(environmentName, fallbackParts) {
  return path.join(
    path.resolve(
      process.env[environmentName] || path.join(os.homedir(), ...fallbackParts)
    ),
    "records"
  )
}

function profileDirectory(root, profileId) {
  return path.join(root, "profiles", profileId)
}

function openExternal(spawn, command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve({ success: true })
    })
  })
}

function chooserArgs(directory) {
  const args = [
    "--file-selection",
    directory ? "--directory" : "--title=Add photo or video"
  ]
  if (!directory) {
    args.push(
      "--file-filter=Photos and videos | *.jpg *.jpeg *.png *.heic *.heif *.tif *.tiff *.webp *.avif *.mov *.mp4 *.avi *.mkv *.webm *.m4v"
    )
  }
  return args
}

export function createOmarchyPlatform(options = {}) {
  const resolve = options.resolveHostTool || findCommand
  const run = options.runCommand || runCommand
  const spawn = options.spawn
  const configRoot = () => xdgRoot("XDG_CONFIG_HOME", [".config"])
  const dataRoot = () => xdgRoot("XDG_DATA_HOME", [".local", "share"])
  const cacheRoot = () => xdgRoot("XDG_CACHE_HOME", [".cache"])
  const choose = async (directory) => {
    try {
      const { stdout } = await run("zenity", chooserArgs(directory), {
        timeout: 0
      })
      return stdout.trim() || null
    } catch (error) {
      if (error.code === 1) return null
      throw error
    }
  }
  const external = async (name, args, missingMessage) => {
    const command = resolve(name)
    if (!command) throw new Error(missingMessage)
    if (spawn) return openExternal(spawn, command, args)
    const { spawn: nodeSpawn } = await import("node:child_process")
    return openExternal(nodeSpawn, command, args)
  }

  return assertPlatform({
    name: "omarchy",
    chooseFile: () => choose(false),
    chooseFolder: () => choose(true),
    async moveToTrash(filePath) {
      const gio = resolve("gio")
      if (!gio) throw new Error("Install glib2 to use system Trash")
      const absolutePath = path.resolve(filePath)
      await run(gio, ["trash", absolutePath])
      if (fs.existsSync(absolutePath)) {
        throw new Error(`System Trash did not remove: ${absolutePath}`)
      }
      return true
    },
    openFile: (filePath) =>
      external("gio", ["open", filePath], "Install glib2 to open attachments"),
    revealFile: (filePath) =>
      external(
        "nautilus",
        ["--select", filePath],
        "Install nautilus to show attachments"
      ),
    async sendNotification() {
      const command = resolve("omarchy-notification-send")
      if (!command) throw new Error("Omarchy notifications are unavailable")
      await run(command, [
        "--app-name",
        "Records",
        "A memory is waiting",
        "See what happened around this day in the past.",
        "--exec",
        "omarchy-shell",
        "records",
        "open",
        "on-this-day-story"
      ])
    },
    resolveHostTool: resolve,
    configDirectory: (profileId) => profileDirectory(configRoot(), profileId),
    dataDirectory: (profileId) => profileDirectory(dataRoot(), profileId),
    cacheDirectory: (profileId) => profileDirectory(cacheRoot(), profileId),
    requestRestart: (restart) => {
      setTimeout(() => restart(75), 50).unref?.()
    },
    capabilities: () => ({
      host: "omarchy",
      desktopImports: false,
      mapOffline: true,
      mediaFolders: true
    })
  })
}

export function createElectronChildPlatform(options = {}) {
  const environment = options.env || process.env
  const processObject = options.process || process
  const requestTimeoutMs = options.requestTimeoutMs || 30_000
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  let nextRequestId = 0
  const pending = new Map()
  const send = options.send || ((message) => processObject.send(message))
  const request =
    options.request ||
    ((method, args = []) => {
      if (!processObject.connected) {
        return Promise.reject(new Error("Electron host is unavailable"))
      }
      const id = ++nextRequestId
      send({ type: "records:host-request", id, method, args })
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => {
          pending.delete(id)
          reject(new Error(`Electron host request timed out: ${method}`))
        }, requestTimeoutMs)
        timer.unref?.()
        pending.set(id, { resolve, reject, timer })
      })
    })

  if (!options.request) {
    processObject.on("message", (message) => {
      if (message?.type !== "records:host-response") return
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimer(entry.timer)
      if (message.error) {
        entry.reject(new Error(message.error.message || message.error))
      } else entry.resolve(message.result)
    })
    processObject.on("disconnect", () => {
      for (const entry of pending.values()) {
        clearTimer(entry.timer)
        entry.reject(new Error("Electron host disconnected"))
      }
      pending.clear()
    })
  }

  const directory = (name, profileId) => {
    const root = environment[name] || environment[name.replace("ECTORY", "")]
    if (!root) throw new Error(`${name} is required for the Electron runtime`)
    return path.join(path.resolve(root), "profiles", profileId)
  }
  return assertPlatform({
    name: "electron",
    chooseFile: () => request("chooseFile"),
    chooseFolder: () => request("chooseFolder"),
    moveToTrash: (filePath) => request("moveToTrash", [filePath]),
    openFile: (filePath) => request("openFile", [filePath]),
    revealFile: (filePath) => request("revealFile", [filePath]),
    sendNotification: (notification) =>
      request("sendNotification", [notification]),
    resolveHostTool: () => null,
    configDirectory: (profileId) =>
      directory("RECORDS_CONFIG_DIRECTORY", profileId),
    dataDirectory: (profileId) =>
      directory("RECORDS_DATA_DIRECTORY", profileId),
    cacheDirectory: (profileId) =>
      directory("RECORDS_CACHE_DIRECTORY", profileId),
    requestRestart: (restart) => {
      setTimeout(() => restart(75), 50).unref?.()
    },
    capabilities: () => ({
      host: "electron",
      desktopImports: true,
      mapOffline: true,
      mediaFolders: true
    })
  })
}

export function selectPlatform(host = process.env.RECORDS_HOST) {
  if (!host || host === "omarchy") return createOmarchyPlatform()
  if (host === "electron") return createElectronChildPlatform()
  throw new Error(`Unsupported RECORDS_HOST: ${host}`)
}

export const platform = selectPlatform()
