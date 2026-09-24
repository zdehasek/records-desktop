import fs from "node:fs"
import {
  activeProfileId,
  profileCacheDirectory,
  profileConfigDirectory,
  profileDataDirectory
} from "./profiles.js"

export function recordsConfigDirectory() {
  return profileConfigDirectory(activeProfileId())
}

export function recordsDataDirectory() {
  return profileDataDirectory(activeProfileId())
}

export function recordsCacheDirectory() {
  return profileCacheDirectory(activeProfileId())
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
