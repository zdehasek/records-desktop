import fs from "node:fs"
import { activeProfileId } from "./profiles.js"
import { platform } from "../platform.js"

export function recordsConfigDirectory() {
  return platform.configDirectory(activeProfileId())
}

export function recordsDataDirectory() {
  return platform.dataDirectory(activeProfileId())
}

export function recordsCacheDirectory() {
  return platform.cacheDirectory(activeProfileId())
}

export function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private path must be an ordinary directory: ${directory}`)
  }
  fs.chmodSync(directory, 0o700)
  return directory
}
