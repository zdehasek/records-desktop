import { spawn } from "node:child_process"
import path from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, dialog, Notification, shell } from "electron"
import { createBackendSupervisor } from "./backend-supervisor.js"
import { createElectronLifecycle } from "./lifecycle.js"
import { createNativeHost } from "./native-host.js"
import { configureElectronPaths } from "./paths.js"

const sourceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
)
const resourcesRoot = () =>
  app.isPackaged ? process.resourcesPath : sourceRoot
const applicationPaths = configureElectronPaths(app)
let focusRoute = () => {}
const nativeHost = createNativeHost({
  dialog,
  shell,
  Notification,
  focusRoute: (route) => focusRoute(route)
})
const supervisor = createBackendSupervisor({
  spawn,
  executable: process.execPath,
  repositoryRoot: resourcesRoot,
  runtimeDirectory: () => path.join(resourcesRoot(), "runtime"),
  workingDirectory: resourcesRoot,
  handleHostRequest: nativeHost,
  environment: () => {
    const environment = {
      HOME: app.getPath("home"),
      TMPDIR: app.getPath("temp"),
      LANG: process.env.LANG ?? "en_US.UTF-8",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      RECORDS_HOST: "electron",
      RECORDS_CONFIG_DIR: applicationPaths.configDirectory,
      RECORDS_DATA_DIR: applicationPaths.dataDirectory,
      RECORDS_CACHE_DIR: applicationPaths.cacheDirectory,
      RECORDS_RESOURCES_PATH: resourcesRoot(),
      RECORDS_VENDOR_ROOT: path.join(resourcesRoot(), "vendor")
    }
    if (app.isPackaged) environment.RECORDS_PACKAGED = "1"
    return environment
  }
})
const lifecycle = createElectronLifecycle({
  app,
  BrowserWindow,
  dialog,
  shell,
  supervisor
})
focusRoute = lifecycle.focusRoute

lifecycle.start()
