import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseDocument } from "../../vendor/yaml.js"

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
export const companionPath = (mediaPath) => `${mediaPath}.md`
const revisionFor = (source) =>
  createHash("sha256").update(source).digest("hex")
const NOTE_COLORS = new Set([
  "white",
  "butter",
  "blush",
  "mint",
  "sky",
  "lavender"
])

function durableFields(frontmatter) {
  const dateOverride = frontmatter.date_override
  if (dateOverride != null && Number.isNaN(new Date(dateOverride).getTime())) {
    throw new Error("media companion has an invalid date override")
  }
  const noteStyle = frontmatter.note_style
  if (
    noteStyle != null &&
    (typeof noteStyle !== "object" || Array.isArray(noteStyle))
  ) {
    throw new Error("media companion note_style must be a mapping")
  }
  const noteColor = noteStyle?.color ?? null
  if (noteColor != null && !NOTE_COLORS.has(noteColor)) {
    throw new Error("media companion has an invalid note color")
  }
  return {
    date_override: dateOverride || null,
    important: frontmatter.important === true,
    note_style: noteColor ? { color: noteColor } : null
  }
}

export function parseMediaCompanion(source, filePath = null) {
  const match = FRONTMATTER_RE.exec(source)
  if (!match) throw new Error("media companion is missing YAML frontmatter")
  const document = parseDocument(match[1], {
    maxAliasCount: 0,
    prettyErrors: true,
    uniqueKeys: true
  })
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join("; "))
  const frontmatter = document.toJS({ maxAliasCount: 0 })
  if (
    !frontmatter ||
    typeof frontmatter !== "object" ||
    Array.isArray(frontmatter)
  ) {
    throw new Error("media companion frontmatter must be a mapping")
  }
  return {
    metadata: durableFields(frontmatter),
    content: source.slice(match[0].length).replace(/^\r?\n/, ""),
    file_path: filePath,
    frontmatter,
    revision: revisionFor(source)
  }
}

function atomicWrite(filePath, source) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = path.join(
    path.dirname(filePath),
    `.records-media-${process.pid}-${randomUUID()}.tmp`
  )
  const handle = fs.openSync(temporary, "wx", 0o600)
  try {
    fs.writeFileSync(handle, source, "utf8")
    fs.fsyncSync(handle)
  } finally {
    fs.closeSync(handle)
  }
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
  try {
    const directory = fs.openSync(path.dirname(filePath), "r")
    try {
      fs.fsyncSync(directory)
    } finally {
      fs.closeSync(directory)
    }
  } catch (error) {
    if (
      !new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(
        error.code
      )
    ) {
      throw error
    }
    // Directory fsync is not supported on every platform/filesystem.
  }
}

export function readMediaCompanion(mediaPath) {
  const filePath = companionPath(mediaPath)
  if (!fs.existsSync(filePath)) return null
  return parseMediaCompanion(fs.readFileSync(filePath, "utf8"), filePath)
}

function assertExpectedRevision(currentSource, expectedRevision) {
  const matches =
    currentSource === null
      ? expectedRevision === null
      : expectedRevision !== null &&
        revisionFor(currentSource) === expectedRevision
  if (matches) return
  const error = new Error("media companion changed outside Records")
  error.code = "MEDIA_COMPANION_CONFLICT"
  throw error
}

function applyDurableFields(document, metadata) {
  for (const [key, value] of Object.entries(durableFields(metadata))) {
    if (key !== "note_style") {
      if (value == null || value === false) document.delete(key)
      else document.set(key, value)
      continue
    }
    if (value?.color) {
      document.setIn(["note_style", "color"], value.color)
      continue
    }
    const current = document.get("note_style", true)
    if (current?.items) {
      document.deleteIn(["note_style", "color"])
      if (!current.items.length) document.delete("note_style")
    }
  }
}

export function writeMediaCompanion(
  mediaPath,
  metadata = {},
  content = "",
  options = {}
) {
  const filePath = companionPath(mediaPath)
  const compareRevision = Object.hasOwn(options, "expectedRevision")
  let currentSource = null
  try {
    currentSource = fs.readFileSync(filePath, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  if (compareRevision)
    assertExpectedRevision(currentSource, options.expectedRevision)
  let document
  if (currentSource !== null) {
    parseMediaCompanion(currentSource, filePath)
    const match = FRONTMATTER_RE.exec(currentSource)
    document = parseDocument(match[1])
  } else {
    document = parseDocument("{}\n")
  }
  applyDurableFields(document, metadata)
  const yaml = document.toString().trimEnd()
  const body = String(content || "")
    .replace(/^\r?\n/, "")
    .trimEnd()
  const source = `---\n${yaml}\n---\n\n${body}${body ? "\n" : ""}`
  const install = options.atomicWrite || atomicWrite
  install(filePath, source)
  const installedSource = fs.readFileSync(filePath, "utf8")
  const installed = parseMediaCompanion(installedSource, filePath)
  if (installedSource !== source) {
    throw new Error("media companion installed-file verification failed")
  }
  return installed
}
