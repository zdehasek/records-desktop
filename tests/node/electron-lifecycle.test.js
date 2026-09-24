import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createElectronLifecycle } from "../../desktop/electron/lifecycle.js"

class FakeWindow extends EventEmitter {
  static instances = []

  constructor(options) {
    super()
    this.options = options
    this.urls = []
    this.visible = false
    this.destroyed = false
    this.webContents = new EventEmitter()
    this.webContents.session = {
      setPermissionRequestHandler: (handler) => {
        this.permissionRequestHandler = handler
      },
      setPermissionCheckHandler: (handler) => {
        this.permissionCheckHandler = handler
      }
    }
    this.webContents.setWindowOpenHandler = (handler) => {
      this.openHandler = handler
    }
    FakeWindow.instances.push(this)
  }

  loadURL(url) {
    this.urls.push(url)
    return Promise.resolve()
  }
  show() {
    this.visible = true
  }
  focus() {
    this.focused = true
  }
  isMinimized() {
    return false
  }
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    this.destroyed = true
    this.emit("closed")
  }
}

function harness({ lock = true, platform = "linux" } = {}) {
  FakeWindow.instances = []
  const app = new EventEmitter()
  app.requestSingleInstanceLock = () => lock
  app.whenReady = () => Promise.resolve()
  app.quitCalls = 0
  app.quit = () => {
    app.quitCalls += 1
  }
  const supervisor = new EventEmitter()
  supervisor.start = async () => ({
    url: "http://127.0.0.1:4040/secret/",
    profile: { id: "family", name: "Family" }
  })
  supervisor.stop = async () => {}
  const external = []
  const lifecycle = createElectronLifecycle({
    app,
    BrowserWindow: FakeWindow,
    dialog: { showMessageBox: async () => {} },
    shell: { openExternal: async (url) => external.push(url) },
    supervisor,
    platform,
    argv: ["records", "photos"]
  })
  return { app, supervisor, lifecycle, external }
}

test("lifecycle enforces one instance and hardened per-profile windows", async () => {
  const { app, lifecycle, external } = harness()
  assert.equal(lifecycle.start(), true)
  assert.equal(app.listenerCount("open-url"), 0)
  await new Promise((resolve) => setImmediate(resolve))
  const window = FakeWindow.instances[0]
  assert.equal(window.options.webPreferences.contextIsolation, true)
  assert.equal(window.options.webPreferences.nodeIntegration, false)
  assert.equal(window.options.webPreferences.sandbox, true)
  assert.equal(
    window.options.webPreferences.partition,
    "persist:records-family"
  )
  assert.equal(window.urls[0], "http://127.0.0.1:4040/secret/#photos")
  assert.equal("preload" in window.options.webPreferences, false)

  assert.deepEqual(window.openHandler({ url: "https://example.com/help" }), {
    action: "deny"
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(external, ["https://example.com/help"])
  assert.deepEqual(window.openHandler({ url: "http://example.com/help" }), {
    action: "deny"
  })

  const event = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  window.webContents.emit("will-navigate", event, "file:///etc/passwd")
  assert.equal(event.prevented, true)
  const sibling = {
    prevented: false,
    preventDefault() {
      this.prevented = true
    }
  }
  window.webContents.emit(
    "will-navigate",
    sibling,
    "http://127.0.0.1:4040/another-token/"
  )
  assert.equal(sibling.prevented, true)
  assert.equal(window.permissionCheckHandler(), false)

  app.emit("second-instance", {}, ["records", "settings"])
  assert.equal(window.urls.at(-1), "http://127.0.0.1:4040/secret/#settings")
  app.emit("second-instance", {}, ["records://open/week"])
  assert.equal(window.urls.at(-1), "http://127.0.0.1:4040/secret/#settings")

  window.destroy()
  app.emit("second-instance", {}, ["records", "today"])
  assert.equal(FakeWindow.instances.length, 2)
})

test("profile switches replace the window and its persistent partition", async () => {
  const { lifecycle, supervisor } = harness()
  lifecycle.start()
  await new Promise((resolve) => setImmediate(resolve))
  const first = lifecycle.getWindow()

  supervisor.emit("ready", {
    url: "http://127.0.0.1:4041/other/",
    profile: { id: "personal", name: "Personal" }
  })

  const second = lifecycle.getWindow()
  assert.equal(first.destroyed, true)
  assert.notEqual(second, first)
  assert.equal(
    second.options.webPreferences.partition,
    "persist:records-personal"
  )
  assert.equal(second.urls[0], "http://127.0.0.1:4041/other/#photos")
})

test("secondary instances quit without starting a backend", () => {
  const { app, lifecycle, supervisor } = harness({ lock: false })
  let starts = 0
  supervisor.start = async () => {
    starts += 1
  }
  assert.equal(lifecycle.start(), false)
  assert.equal(app.quitCalls, 1)
  assert.equal(starts, 0)
})

test("window-all-closed follows conventional macOS behavior", () => {
  const mac = harness({ platform: "darwin" })
  mac.lifecycle.start()
  mac.app.emit("window-all-closed")
  assert.equal(mac.app.quitCalls, 0)

  const linux = harness({ platform: "linux" })
  linux.lifecycle.start()
  linux.app.emit("window-all-closed")
  assert.equal(linux.app.quitCalls, 1)
})
