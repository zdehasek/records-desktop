import { mkdirSync } from "node:fs"
import path from "node:path"

export function configureElectronPaths(app, options = {}) {
  const makeDirectory = options.makeDirectory ?? mkdirSync
  const dataDirectory =
    options.dataDirectory ?? path.join(app.getPath("appData"), "records")
  const configDirectory = options.configDirectory ?? dataDirectory
  const cacheDirectory =
    options.cacheDirectory ?? path.join(app.getPath("cache"), "records")
  const userDataDirectory = path.join(dataDirectory, "electron")
  const sessionDataDirectory = path.join(userDataDirectory, "session")

  for (const directory of new Set([
    configDirectory,
    dataDirectory,
    cacheDirectory,
    userDataDirectory,
    sessionDataDirectory
  ])) {
    makeDirectory(directory, { recursive: true, mode: 0o700 })
  }
  app.setPath("userData", userDataDirectory)
  app.setPath("sessionData", sessionDataDirectory)

  return {
    configDirectory,
    dataDirectory,
    cacheDirectory,
    userDataDirectory,
    sessionDataDirectory
  }
}
