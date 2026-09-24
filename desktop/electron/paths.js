import { mkdirSync } from "node:fs"
import path from "node:path"

export function configureElectronPaths(app, options = {}) {
  const makeDirectory = options.makeDirectory ?? mkdirSync
  const dataDirectory = path.join(app.getPath("appData"), "records")
  const cacheDirectory = path.join(app.getPath("cache"), "records")
  const userDataDirectory = path.join(dataDirectory, "electron")
  const sessionDataDirectory = path.join(userDataDirectory, "session")

  for (const directory of [
    dataDirectory,
    cacheDirectory,
    userDataDirectory,
    sessionDataDirectory
  ]) {
    makeDirectory(directory, { recursive: true, mode: 0o700 })
  }
  app.setPath("userData", userDataDirectory)
  app.setPath("sessionData", sessionDataDirectory)

  return {
    configDirectory: dataDirectory,
    dataDirectory,
    cacheDirectory,
    userDataDirectory,
    sessionDataDirectory
  }
}
