import fs from "node:fs"
import path from "node:path"
import { resolveRootPath } from "../file-roots.js"
import { parseVisibilityPath } from "../services/visibility-path.js"

export const messageTypeForMime = (mimeType = "") =>
  mimeType.startsWith("video/") ? "video" : "photo"

export function metadataForRow(row) {
  const metadata = {
    ...(row.duration_seconds != null && {
      duration_seconds: row.duration_seconds
    }),
    ...(Boolean(row.important) && { important: true }),
    ...(row.note_color && { note_style: { color: row.note_color } })
  }
  return Object.keys(metadata).length ? metadata : null
}

export function exifForRow(row) {
  return row.exif_data ? JSON.parse(row.exif_data) : null
}

export function visibilityForRow(row) {
  return parseVisibilityPath(row.relative_path).visibility
}

export function rowIsVisible(row, options = {}) {
  const visibility = visibilityForRow(row)
  if (visibility === "visible") return true
  if (visibility.startsWith(".")) return Boolean(options.dotFilesVisible)
  return options.nsfwMode !== "hidden"
}

export function rootForRow(row, config) {
  return (
    config?.mediaRoots?.().find((root) => root.name === row.root_name) || null
  )
}

export function filePathForRow(row, config) {
  const root = rootForRow(row, config)
  return root ? resolveRootPath(root, row.relative_path) : null
}

export function messageForRow(row) {
  const exif = exifForRow(row)
  const date = row.created_at.slice(0, 10)
  return {
    id: row.id,
    message_id: row.id,
    day_id: date,
    day_date: date,
    content: row.content,
    message_type: messageTypeForMime(row.mime_type),
    metadata: metadataForRow(row),
    visibility: visibilityForRow(row),
    latitude: exif?.latitude ?? null,
    longitude: exif?.longitude ?? null,
    created_at: row.created_at,
    updated_at: row.created_at
  }
}

export function attachmentForRow(row, config) {
  const exif = exifForRow(row)
  const filePath = filePathForRow(row, config)
  return {
    id: row.id,
    message_id: row.id,
    root_name: row.root_name,
    relative_path: row.relative_path,
    file_path: filePath,
    file_name: path.basename(row.relative_path),
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    checksum: null,
    content_fingerprint: row.content_fingerprint,
    exif_data: exif,
    latitude: exif?.latitude ?? null,
    longitude: exif?.longitude ?? null,
    is_symlink:
      filePath && fs.existsSync(filePath)
        ? Number(fs.lstatSync(filePath).isSymbolicLink())
        : 0,
    created_at: row.created_at,
    mtime_ms: row.mtime_ms
  }
}
