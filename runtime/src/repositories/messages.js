import fs from "node:fs"
import path from "node:path"
import { wrapDb } from "../db/repo-helpers.js"
import { validateRootName } from "../file-roots.js"
import {
  attachmentForRow,
  messageForRow,
  rowIsVisible,
  visibilityForRow
} from "./media-row.js"

const COLORS = new Set(["white", "butter", "blush", "mint", "sky", "lavender"])
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/

function row(db, id) {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").get(id)
}

function trustedProjection(metadata = null) {
  const color = metadata?.note_style?.color ?? null
  if (color != null && !COLORS.has(color)) throw new Error("Invalid note color")
  const duration = metadata?.duration_seconds
  if (
    metadata &&
    Object.hasOwn(metadata, "important") &&
    typeof metadata.important !== "boolean"
  ) {
    throw new Error("Invalid media importance")
  }
  if (
    duration != null &&
    (!Number.isFinite(duration) || duration < 0 || duration >= 1e308)
  ) {
    throw new Error("Invalid media duration")
  }
  return {
    duration: duration ?? null,
    important: metadata?.important === true ? 1 : 0,
    color
  }
}

function validateProjectionInput(
  mimeType,
  content,
  contentFingerprint,
  exifData
) {
  if (typeof mimeType !== "string" || !/^(image|video)\/.+$/.test(mimeType)) {
    throw new Error("Invalid attachment projection")
  }
  if (
    typeof content !== "string" ||
    (contentFingerprint !== null && typeof contentFingerprint !== "string") ||
    (exifData !== null &&
      (typeof exifData !== "object" || Array.isArray(exifData)))
  ) {
    throw new Error("Invalid attachment projection")
  }
  try {
    if (exifData !== null) JSON.stringify(exifData)
  } catch {
    throw new Error("Invalid attachment projection")
  }
}

function validateMediaRoot(mediaRoot) {
  if (
    typeof mediaRoot?.name !== "string" ||
    typeof mediaRoot?.path !== "string" ||
    !mediaRoot.path
  ) {
    throw new Error("media root name and path are required")
  }
  validateRootName(mediaRoot.name)
}

function validateCoordinates(latitude, longitude) {
  if ((latitude == null) !== (longitude == null)) {
    throw new Error("GPS latitude and longitude must be provided together")
  }
  if (latitude == null) return
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("Invalid attachment latitude")
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Invalid attachment longitude")
  }
}

function sourceProjection(filePath, byteSize, mediaRoot) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile()) throw new Error("Attachment must be a regular file")
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < 0 ||
    byteSize !== stat.size
  ) {
    throw new Error("Attachment byte size does not match file")
  }
  const rootPath = path.resolve(mediaRoot.path)
  const absoluteFilePath = path.resolve(filePath)
  const relative = path.relative(rootPath, absoluteFilePath)
  const realRelative = path.relative(
    fs.realpathSync(rootPath),
    fs.realpathSync(absoluteFilePath)
  )
  const escapes = (value) =>
    !value ||
    value === ".." ||
    value.startsWith(`..${path.sep}`) ||
    path.isAbsolute(value)
  if (escapes(relative) || escapes(realRelative)) {
    throw new Error("Attachment must be inside its media root")
  }
  return { relativePath: relative.split(path.sep).join("/"), stat }
}

export const list = wrapDb("messages.list", (db, dayId, opts = {}) =>
  db
    .prepare(
      `SELECT * FROM attachments
        WHERE created_at >= ? AND created_at < date(?, '+1 day')
        ORDER BY created_at`
    )
    .all(String(dayId), String(dayId))
    .filter((item) => rowIsVisible(item, opts))
    .map(messageForRow)
)

export const get = wrapDb("messages.get", (db, id) => {
  const found = row(db, id)
  return found ? messageForRow(found) : undefined
})

export function addPhoto(
  db,
  _dayId,
  filePath,
  _fileName,
  mimeType,
  byteSize,
  _checksum,
  exifData,
  latitude,
  longitude,
  metadata = null,
  createdAt = null,
  mediaRoot = null,
  content = "",
  identities = {}
) {
  validateMediaRoot(mediaRoot)
  const timestamp = createdAt || new Date().toISOString()
  if (
    typeof timestamp !== "string" ||
    !TIMESTAMP_RE.test(timestamp) ||
    Number.isNaN(new Date(timestamp).getTime())
  ) {
    throw new Error(`Invalid created_at: ${createdAt}`)
  }
  validateCoordinates(latitude, longitude)
  const contentFingerprint = identities?.contentFingerprint ?? null
  validateProjectionInput(mimeType, content, contentFingerprint, exifData)
  const { relativePath, stat } = sourceProjection(filePath, byteSize, mediaRoot)
  const projection = trustedProjection(metadata)
  const projectedExif = {
    ...(exifData || {}),
    ...(latitude != null && longitude != null && { latitude, longitude })
  }
  const result = db
    .prepare(
      `INSERT INTO attachments
       (root_name, relative_path, mime_type, byte_size, mtime_ms, content,
         duration_seconds, important, note_color, content_fingerprint, exif_data,
         source_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(
      mediaRoot.name,
      relativePath,
      mimeType,
      byteSize,
      stat.mtimeMs,
      content,
      projection.duration,
      projection.important,
      projection.color,
      contentFingerprint,
      Object.keys(projectedExif).length ? JSON.stringify(projectedExif) : null,
      timestamp
    )
  const inserted = row(db, Number(result.lastInsertRowid))
  const config = { mediaRoots: () => [mediaRoot] }
  return {
    message: messageForRow(inserted),
    attachment: attachmentForRow(inserted, config)
  }
}

export const destroy = wrapDb("messages.destroy", (db, id) =>
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id)
)

export const setVisibility = wrapDb("messages.setVisibility", (db, id) => {
  const updated = row(db, id)
  return updated ? messageForRow(updated) : undefined
})

export const listFolders = wrapDb("messages.listFolders", (db) =>
  [
    ...new Set(
      db
        .prepare("SELECT relative_path FROM attachments")
        .all()
        .map(visibilityForRow)
        .filter((visibility) => visibility !== "visible")
    )
  ].sort()
)

export const listFolderItems = wrapDb(
  "messages.listFolderItems",
  (db, folder) =>
    db
      .prepare("SELECT * FROM attachments ORDER BY created_at DESC")
      .all()
      .filter((item) => {
        const visibility = visibilityForRow(item)
        return folder ? visibility === folder : visibility !== "visible"
      })
      .map((item) => ({
        ...messageForRow(item),
        folder: visibilityForRow(item),
        attachment_id: item.id,
        file_name: path.basename(item.relative_path),
        mime_type: item.mime_type
      }))
)
