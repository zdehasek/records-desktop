import process from "node:process"
import { URL } from "node:url"
import { routeFromArguments, validateRoute } from "./protocol.js"

export function createElectronLifecycle(options) {
  const {
    app,
    BrowserWindow,
    dialog,
    shell,
    supervisor,
    platform = process.platform,
    argv = process.argv
  } = options
  let window = null
  let ready = null
  let route = routeFromArguments(argv) ?? "today"
  let quitting = false

  const createWindow = (backend) => {
    ready = backend
    const applicationUrl = new URL(backend.url)
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 760,
      minHeight: 540,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        partition: `persist:records-${backend.profile.id}`
      }
    })
    const currentWindow = window
    const isApplicationUrl = (value) => {
      try {
        const target = new URL(value)
        return (
          target.origin === applicationUrl.origin &&
          target.pathname.startsWith(applicationUrl.pathname) &&
          !target.username &&
          !target.password
        )
      } catch {
        return false
      }
    }
    const openApprovedExternal = (value) => {
      try {
        const target = new URL(value)
        if (
          target.protocol === "https:" &&
          target.hostname !== "127.0.0.1" &&
          target.hostname !== "localhost"
        ) {
          void shell.openExternal(target.href)
        }
      } catch {
        // Deny malformed URLs.
      }
    }
    currentWindow.webContents.setWindowOpenHandler(({ url }) => {
      openApprovedExternal(url)
      return { action: "deny" }
    })
    const guardNavigation = (event, url) => {
      if (isApplicationUrl(url)) return
      event.preventDefault()
      openApprovedExternal(url)
    }
    currentWindow.webContents.on("will-navigate", guardNavigation)
    currentWindow.webContents.on("will-redirect", guardNavigation)
    currentWindow.webContents.on("render-process-gone", () => {
      if (window === currentWindow) window = null
      if (!quitting && ready) createWindow(ready)
    })
    currentWindow.webContents.session?.setPermissionRequestHandler?.(
      (_webContents, _permission, callback) => callback(false)
    )
    currentWindow.webContents.session?.setPermissionCheckHandler?.(() => false)
    currentWindow.once("ready-to-show", () => currentWindow.show())
    currentWindow.on("closed", () => {
      if (window === currentWindow) window = null
    })
    void currentWindow.loadURL(`${backend.url}#${route}`)
    return currentWindow
  }

  const focusRoute = (requestedRoute) => {
    route = validateRoute(requestedRoute)
    if (!window || window.isDestroyed()) {
      if (ready) createWindow(ready)
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    void window.loadURL(`${ready.url}#${route}`)
  }

  const showStartupError = async (error) => {
    await dialog.showMessageBox({
      type: "error",
      title: "Records could not start",
      message: "Records could not start its local backend.",
      detail: error.message
    })
    app.quit()
  }

  const start = () => {
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return false
    }
    app.on("second-instance", (_event, commandLine) => {
      focusRoute(routeFromArguments(commandLine) ?? route)
    })
    app.on("before-quit", (event) => {
      if (quitting) return
      event.preventDefault()
      quitting = true
      void supervisor.stop().finally(() => app.quit())
    })
    app.on("window-all-closed", () => {
      if (platform !== "darwin") app.quit()
    })
    app.on("activate", () => focusRoute(route))
    supervisor.on("ready", (backend) => {
      if (window && !window.isDestroyed()) window.destroy()
      createWindow(backend)
    })
    supervisor.on("error", showStartupError)

    void app.whenReady().then(async () => {
      try {
        const backend = await supervisor.start()
        if (!window) createWindow(backend)
      } catch (error) {
        await showStartupError(error)
      }
    })
    return true
  }

  return {
    start,
    focusRoute,
    getWindow: () => window
  }
}
