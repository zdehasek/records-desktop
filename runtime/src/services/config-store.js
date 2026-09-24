import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseDocument, stringify } from "../../vendor/yaml.js"
import {
  comparablePath,
  validateRootName,
  validateRoots
} from "../file-roots.js"
import { ensurePrivateDirectory, recordsConfigDirectory } from "../paths.js"
import { profileInfo } from "../profiles.js"

const VERSION = 4
const CONFIG_KEYS = new Set(["version", "profile", "media", "preferences"])
const PREFERENCE_KEYS = new Set([
  "auto_photo_in_week_overview",
  "nsfw_mode",
  "on_this_day_last_notified",
  "on_this_day_notification_time",
  "on_this_day_notifications",
  "onboarding_completed",
  "week_start_day"
])

function rejectUnknownKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`)
  }
  const unknown = Object.keys(value).find((key) => !allowed.has(key))
  if (unknown) throw new Error(`unsupported ${label} field: ${unknown}`)
}

export function defaultConfigPath() {
  if (process.env.RECORDS_CONFIG_PATH) {
    return path.resolve(process.env.RECORDS_CONFIG_PATH)
  }
  return path.join(recordsConfigDirectory(), "config.yaml")
}

function atomicWrite(filePath, contents) {
  const directory = ensurePrivateDirectory(path.dirname(filePath))
  const temporary = path.join(
    directory,
    `.config-${process.pid}-${randomUUID()}.tmp`
  )
  const handle = fs.openSync(temporary, "wx", 0o600)
  try {
    fs.writeFileSync(
      handle,
      contents.endsWith("\n") ? contents : `${contents}\n`,
      "utf8"
    )
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

function defaultConfig() {
  return {
    version: VERSION,
    profile: { name: profileInfo().name },
    media: { roots: [], defaultRoot: null },
    preferences: {}
  }
}

function validateProfile(profile) {
  if (profile === undefined) return
  rejectUnknownKeys(profile, new Set(["name"]), "profile")
  if (typeof profile.name !== "string" || !profile.name.trim()) {
    throw new Error("profile name must be a non-empty string")
  }
}

function normalizeMediaRoots(media) {
  for (const root of media.roots || []) {
    rejectUnknownKeys(root, new Set(["name", "path", "enabled"]), "media root")
  }
  const roots = validateRoots(media.roots || [], "media root")
  if (roots.some((root) => root.path === path.parse(root.path).root)) {
    throw new Error("media root cannot be the filesystem root")
  }
  return roots
}

function validateDefaultRootType(defaultRoot) {
  if (defaultRoot !== null && typeof defaultRoot !== "string") {
    throw new Error("default media root must be a root name or null")
  }
}

function selectedDefaultRoot(roots, defaultRoot) {
  if (!roots.length && defaultRoot !== null) {
    throw new Error("default media root must be null when no roots exist")
  }
  const selected = roots.find((root) => root.name === defaultRoot)
  if (roots.length && !selected) {
    throw new Error("default media root is not configured")
  }
  return selected
}

function validateDefaultRootEnabled(selected) {
  if (selected && !selected.enabled) {
    throw new Error("default media root must be enabled")
  }
}

function normalizeDefaultRoot(roots, value) {
  const defaultRoot = value ?? null
  validateDefaultRootType(defaultRoot)
  validateDefaultRootEnabled(selectedDefaultRoot(roots, defaultRoot))
  return defaultRoot
}

function normalizeMedia(media) {
  rejectUnknownKeys(media, new Set(["roots", "defaultRoot"]), "media")
  const roots = normalizeMediaRoots(media)
  return {
    roots,
    defaultRoot: normalizeDefaultRoot(roots, media.defaultRoot)
  }
}

function normalizeConfig(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    data.version !== VERSION
  ) {
    throw new Error(`unsupported Records config version: ${data?.version}`)
  }
  rejectUnknownKeys(data, CONFIG_KEYS, "Records config")
  validateProfile(data.profile)
  rejectUnknownKeys(data.preferences || {}, PREFERENCE_KEYS, "preference")
  return {
    ...data,
    version: VERSION,
    media: normalizeMedia(data.media),
    preferences: { ...(data.preferences || {}) }
  }
}

function selectedDirectory(rootPath) {
  const candidate = path.resolve(rootPath)
  if (candidate === path.parse(candidate).root) {
    throw new Error("media folder cannot be the filesystem root")
  }
  let stat
  try {
    stat = fs.lstatSync(candidate)
  } catch {
    throw new Error("media folder must exist")
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("media folder must be an ordinary directory")
  }
  return fs.realpathSync(candidate)
}

function generatedName(rootPath, existing, fallback) {
  const base =
    path
      .basename(rootPath)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  let name = base
  let suffix = 2
  while (existing.some((entry) => entry.name === name)) {
    name = `${base}-${suffix++}`
  }
  return validateRootName(name)
}

function updateRootNode(node, root) {
  for (const key of ["name", "path", "enabled"]) {
    const scalar = node.get(key, true)
    if (scalar && typeof scalar === "object" && "value" in scalar) {
      scalar.value = root[key]
    } else {
      node.set(key, root[key])
    }
  }
  return node
}

function rootPathFromNode(node) {
  const rootPath = node?.get?.("path")
  return typeof rootPath === "string" && path.isAbsolute(rootPath)
    ? path.resolve(rootPath)
    : null
}

function updateRootNodes(document, pathParts, roots) {
  let sequence = document.getIn(pathParts, true)
  if (!sequence?.items) {
    sequence = document.createNode([])
    document.setIn(pathParts, sequence)
  }
  const available = sequence.items.map((node) => ({
    node,
    path: rootPathFromNode(node)
  }))
  sequence.items = roots.map((root) => {
    const normalizedPath = path.resolve(root.path)
    const index = available.findIndex((entry) => entry.path === normalizedPath)
    if (index === -1) {
      return document.createNode({
        name: root.name,
        path: normalizedPath,
        enabled: root.enabled
      })
    }
    const [{ node }] = available.splice(index, 1)
    return updateRootNode(node, { ...root, path: normalizedPath })
  })
}

export class RecordsConfig {
  constructor(filePath = defaultConfigPath()) {
    this.filePath = path.resolve(filePath)
    this.document = null
    this.data = null
    this.persistedSource = null
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.document = parseDocument(stringify(defaultConfig()))
      this.data = normalizeConfig(this.document.toJS())
      atomicWrite(this.filePath, this.document.toString())
      this.persistedSource = this.document.toString()
      return this.data
    }
    const configStat = fs.lstatSync(this.filePath)
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      throw new Error("Records config must be an ordinary file")
    }
    const source = fs.readFileSync(this.filePath, "utf8")
    const document = parseDocument(source)
    if (document.errors.length) throw document.errors[0]
    const data = normalizeConfig(document.toJS())
    this.document = document
    this.data = data
    this.persistedSource = source
    fs.chmodSync(this.filePath, 0o600)
    return this.data
  }

  save() {
    try {
      const data = normalizeConfig(this.document.toJS())
      const source = this.document.toString()
      atomicWrite(this.filePath, source)
      this.data = data
      this.persistedSource = source
    } catch (error) {
      if (this.persistedSource !== null) {
        this.document = parseDocument(this.persistedSource)
        this.data = normalizeConfig(this.document.toJS())
      }
      throw error
    }
    return this.data
  }

  set(pathParts, value) {
    this.document.setIn(pathParts, value)
    return this.save()
  }

  setRootNodes(pathParts, roots) {
    updateRootNodes(this.document, pathParts, roots)
    return this.save()
  }

  allSettings() {
    return { ...this.data.preferences }
  }

  getSetting(key) {
    return this.data.preferences[key]
  }

  setSetting(key, value) {
    this.set(["preferences", key], value)
    return { key, value }
  }

  mediaRoots({ enabledOnly = false } = {}) {
    const roots = this.data.media.roots
    return (enabledOnly ? roots.filter((root) => root.enabled) : roots).map(
      (root) => ({ ...root })
    )
  }

  defaultMediaRoot() {
    const root = this.data.media.roots.find(
      (entry) => entry.name === this.data.media.defaultRoot
    )
    return root ? { ...root } : null
  }

  setMediaState(roots, defaultRoot) {
    updateRootNodes(this.document, ["media", "roots"], roots)
    this.document.setIn(["media", "defaultRoot"], defaultRoot)
    return this.save()
  }

  addMediaRoot(rootPath) {
    const candidate = selectedDirectory(rootPath)
    if (
      this.data.media.roots.some(
        (root) => comparablePath(root.path) === comparablePath(candidate)
      )
    ) {
      return null
    }
    const root = {
      name: generatedName(candidate, this.data.media.roots, "media-root"),
      path: candidate,
      enabled: true
    }
    this.setMediaState(
      [...this.data.media.roots, root],
      this.data.media.defaultRoot || root.name
    )
    return { ...root }
  }

  removeMediaRoot(rootPath) {
    const candidate = path.resolve(rootPath)
    const removed = this.data.media.roots.find(
      (root) => root.path === candidate
    )
    if (!removed) return false
    if (
      removed.name === this.data.media.defaultRoot &&
      this.data.media.roots.length > 1
    ) {
      throw new Error("Choose another default folder before removing this one")
    }
    const roots = this.data.media.roots.filter(
      (root) => root.path !== candidate
    )
    this.setMediaState(
      roots,
      removed.name === this.data.media.defaultRoot
        ? null
        : this.data.media.defaultRoot
    )
    return true
  }

  toggleMediaRoot(rootPath, enabled) {
    if (typeof enabled !== "boolean") {
      throw new Error("media folder enabled state must be boolean")
    }
    const candidate = path.resolve(rootPath)
    const index = this.data.media.roots.findIndex(
      (item) => item.path === candidate
    )
    if (index < 0) throw new Error("media folder not found")
    const root = this.data.media.roots[index]
    if (!enabled && root.name === this.data.media.defaultRoot) {
      throw new Error("Choose another default folder before pausing this one")
    }
    this.set(["media", "roots", index, "enabled"], enabled)
    return { ...this.data.media.roots[index] }
  }

  setDefaultMediaRoot(rootPath) {
    const candidate = path.resolve(rootPath)
    const root = this.data.media.roots.find((entry) => entry.path === candidate)
    if (!root) throw new Error("media folder not found")
    if (!root.enabled) throw new Error("default media folder must be enabled")
    selectedDirectory(root.path)
    this.set(["media", "defaultRoot"], root.name)
    return { ...root }
  }
}

export function openRecordsConfig(filePath = defaultConfigPath()) {
  const config = new RecordsConfig(filePath)
  config.load()
  return config
}
