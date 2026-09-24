import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import path from "node:path"
import test from "node:test"
import {
  createElectronChildPlatform,
  createOmarchyPlatform,
  selectPlatform
} from "../../runtime/platform.js"

test("platform selection rejects unknown hosts", () => {
  assert.equal(selectPlatform("omarchy").name, "omarchy")
  assert.throws(() => selectPlatform("unknown"), /Unsupported RECORDS_HOST/)
})

test("Omarchy adapter preserves chooser, trash, and notification commands", async () => {
  const calls = []
  const tools = {
    gio: "/tools/gio",
    "omarchy-notification-send": "/tools/notify"
  }
  const platform = createOmarchyPlatform({
    resolveHostTool: (name) => tools[name] || null,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options })
      return { stdout: command === "zenity" ? "/chosen/path\n" : "" }
    }
  })

  assert.equal(await platform.chooseFile(), "/chosen/path")
  assert.equal(await platform.chooseFolder(), "/chosen/path")
  await platform.sendNotification()
  assert.deepEqual(calls[0].args.slice(0, 2), [
    "--file-selection",
    "--title=Add photo or video"
  ])
  assert.deepEqual(calls[1].args, ["--file-selection", "--directory"])
  assert.deepEqual(calls[2].args.slice(0, 2), ["--app-name", "Records"])
})

test("Electron child adapter delegates host operations and owns profile directories", async () => {
  const requests = []
  const platform = createElectronChildPlatform({
    env: {
      RECORDS_CONFIG_DIR: "/host/config",
      RECORDS_DATA_DIR: "/host/data",
      RECORDS_CACHE_DIR: "/host/cache"
    },
    request: async (method, args = []) => {
      requests.push({ method, args })
      return method === "chooseFile" ? "/photo.jpg" : true
    }
  })

  assert.equal(await platform.chooseFile(), "/photo.jpg")
  await platform.openFile("/photo.jpg")
  let restartCode = null
  platform.requestRestart((code) => {
    restartCode = code
  })
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.deepEqual(requests, [
    { method: "chooseFile", args: [] },
    { method: "openFile", args: ["/photo.jpg"] }
  ])
  assert.equal(restartCode, 75)
  assert.equal(
    platform.configDirectory("work"),
    path.join("/host/config", "profiles", "work")
  )
  assert.equal(platform.resolveHostTool("gio"), null)
  assert.equal(platform.capabilities().desktopImports, true)
  assert.equal(platform.name, "electron")
})

test("Electron child requests reject on timeout and disconnect", async () => {
  const child = new EventEmitter()
  child.connected = true
  child.send = () => {}
  const timed = createElectronChildPlatform({
    process: child,
    env: {
      RECORDS_CONFIG_DIR: "/config",
      RECORDS_DATA_DIR: "/data",
      RECORDS_CACHE_DIR: "/cache"
    },
    requestTimeoutMs: 1,
    setTimer: (callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref = () => timer
      return timer
    }
  })
  await assert.rejects(timed.chooseFile(), /timed out/)

  const pending = createElectronChildPlatform({
    process: child,
    env: {
      RECORDS_CONFIG_DIR: "/config",
      RECORDS_DATA_DIR: "/data",
      RECORDS_CACHE_DIR: "/cache"
    },
    requestTimeoutMs: 10_000
  })
  const request = pending.chooseFolder()
  child.emit("disconnect")
  await assert.rejects(request, /disconnected/)
})
