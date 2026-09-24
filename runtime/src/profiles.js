import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { platform } from "../platform.js"
import { parseDocument, stringify } from "../vendor/yaml.js"

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const INTERNAL_PROFILE_ENV = "RECORDS_PROFILE_ID"

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Private path must be an ordinary directory: ${directory}`)
  }
  fs.chmodSync(directory, 0o700)
  return directory
}

function atomicWrite(filePath, contents) {
  const directory = privateDirectory(path.dirname(filePath))
  const temporary = path.join(
    directory,
    `.profile-${process.pid}-${randomUUID()}.tmp`
  )
  const handle = fs.openSync(temporary, "wx", 0o600)
  try {
    fs.writeFileSync(handle, contents, "utf8")
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

export function validateProfileId(value) {
  if (typeof value !== "string" || !PROFILE_ID.test(value)) {
    throw new Error(
      "Profile ID must use lowercase letters, numbers, dashes, or underscores"
    )
  }
  return value
}

export function recordsConfigRoot() {
  return path.dirname(path.dirname(platform.configDirectory("production")))
}

export function recordsDataRoot() {
  return path.dirname(path.dirname(platform.dataDirectory("production")))
}

export function recordsCacheRoot() {
  return path.dirname(path.dirname(platform.cacheDirectory("production")))
}

export function profileConfigDirectory(profileId) {
  return path.join(
    recordsConfigRoot(),
    "profiles",
    validateProfileId(profileId)
  )
}

export function profileDataDirectory(profileId) {
  return path.join(recordsDataRoot(), "profiles", validateProfileId(profileId))
}

export function profileCacheDirectory(profileId) {
  return path.join(recordsCacheRoot(), "profiles", validateProfileId(profileId))
}

export function profileConfigPath(profileId) {
  return path.join(profileConfigDirectory(profileId), "config.yaml")
}

export function activeProfilePath() {
  return path.join(recordsConfigRoot(), "active-profile")
}

export function pendingProfilePath() {
  return path.join(recordsConfigRoot(), "pending-profile")
}

function readProfileMarker(filePath) {
  try {
    return validateProfileId(fs.readFileSync(filePath, "utf8").trim())
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function writeProfileMarker(filePath, profileId) {
  atomicWrite(filePath, `${validateProfileId(profileId)}\n`)
}

export function activeProfileId() {
  const internal = process.env[INTERNAL_PROFILE_ENV]
  if (internal) return validateProfileId(internal)
  return readProfileMarker(activeProfilePath()) || "production"
}

export function startupProfileId() {
  return readProfileMarker(pendingProfilePath()) || activeProfileId()
}

export function selectRuntimeProfile(profileId) {
  process.env[INTERNAL_PROFILE_ENV] = validateProfileId(profileId)
}

export function requestProfileSwitch(profileId) {
  const id = validateProfileId(profileId)
  if (!fs.existsSync(profileConfigPath(id))) {
    throw new Error(`Profile does not exist: ${id}`)
  }
  writeProfileMarker(pendingProfilePath(), id)
  return id
}

export function commitStartupProfile(profileId) {
  const id = validateProfileId(profileId)
  const pending = readProfileMarker(pendingProfilePath())
  if (pending && pending !== id) {
    throw new Error("Profile startup does not match the pending switch")
  }
  const previous = readProfileMarker(activeProfilePath())
  writeProfileMarker(activeProfilePath(), id)
  try {
    fs.rmSync(pendingProfilePath(), { force: true })
  } catch (error) {
    if (previous) writeProfileMarker(activeProfilePath(), previous)
    else fs.rmSync(activeProfilePath(), { force: true })
    throw error
  }
}

export function rollbackPendingProfile(profileId) {
  const pending = readProfileMarker(pendingProfilePath())
  if (pending === validateProfileId(profileId)) {
    fs.rmSync(pendingProfilePath(), { force: true })
  }
}

function profileName(configPath, fallback) {
  try {
    const document = parseDocument(fs.readFileSync(configPath, "utf8"))
    if (document.errors.length) return fallback
    const name = document.toJS()?.profile?.name
    return typeof name === "string" && name.trim() ? name.trim() : fallback
  } catch {
    return fallback
  }
}

function defaultProfileName(profileId) {
  return profileId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ")
}

export function listProfiles() {
  const directory = path.join(recordsConfigRoot(), "profiles")
  if (!fs.existsSync(directory)) return []
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        PROFILE_ID.test(entry.name) &&
        fs.existsSync(profileConfigPath(entry.name))
    )
    .map((entry) => ({
      id: entry.name,
      name: profileName(
        profileConfigPath(entry.name),
        defaultProfileName(entry.name)
      )
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function profileInfo(profileId = activeProfileId()) {
  const id = validateProfileId(profileId)
  return {
    id,
    name: profileName(profileConfigPath(id), defaultProfileName(id))
  }
}

export function assertManagedProfileEnvironment() {
  for (const name of ["RECORDS_CONFIG_PATH", "RECORDS_DB_PATH"]) {
    if (process.env[name]) {
      throw new Error(`${name} cannot be used with managed profiles`)
    }
  }
}

function profileIdFromName(name) {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return validateProfileId(id)
}

export async function createProfile({ name }) {
  const displayName = String(name || "").trim()
  if (!displayName || displayName.length > 64) {
    throw new Error("Profile name must be between 1 and 64 characters")
  }
  const id = profileIdFromName(displayName)
  const configDirectory = profileConfigDirectory(id)
  const dataDirectory = profileDataDirectory(id)
  const cacheDirectory = profileCacheDirectory(id)
  if (
    fs.existsSync(configDirectory) ||
    fs.existsSync(dataDirectory) ||
    fs.existsSync(cacheDirectory)
  ) {
    throw new Error(`Profile already exists: ${id}`)
  }
  let reserved = false
  try {
    privateDirectory(path.dirname(configDirectory))
    fs.mkdirSync(configDirectory, { mode: 0o700 })
    reserved = true
    privateDirectory(dataDirectory)
    const config = {
      version: 4,
      profile: { name: displayName },
      media: { roots: [], defaultRoot: null },
      preferences: {}
    }
    atomicWrite(profileConfigPath(id), `${stringify(config).trimEnd()}\n`)
    return { id, name: displayName }
  } catch (error) {
    if (reserved && !fs.existsSync(profileConfigPath(id))) {
      fs.rmSync(dataDirectory, { recursive: true, force: true })
      fs.rmSync(configDirectory, { recursive: true, force: true })
    }
    throw error
  }
}
