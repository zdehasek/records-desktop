import { wrapDb } from "../db/repo-helpers.js"
import { attachmentForRow, messageForRow, rowIsVisible } from "./media-row.js"

const allRows = (db) => db.prepare("SELECT * FROM attachments").all()
const NOTE_COLORS = new Set([
  "white",
  "butter",
  "blush",
  "mint",
  "sky",
  "lavender"
])
const mediaVisual = (row) =>
  row.mime_type.startsWith("image/") || row.mime_type.startsWith("video/")

const summarize = (row, config) => ({
  ...attachmentForRow(row, config),
  ...messageForRow(row),
  message_id: row.id,
  message_content: row.content
})

export const list = wrapDb("attachments.list", (db, dayId, opts = {}, config) =>
  db
    .prepare(
      `SELECT * FROM attachments
        WHERE created_at >= ? AND created_at < date(?, '+1 day')
        ORDER BY created_at`
    )
    .all(String(dayId), String(dayId))
    .filter((row) => rowIsVisible(row, opts))
    .map((row) => attachmentForRow(row, config))
)

export const listAll = wrapDb("attachments.listAll", (db, opts = {}, config) =>
  allRows(db)
    .filter(mediaVisual)
    .filter((row) => rowIsVisible(row, opts))
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
    .map((row) => summarize(row, config))
)

export const listAllWithPaths = wrapDb(
  "attachments.listAllWithPaths",
  (db, config) =>
    allRows(db)
      .filter(mediaVisual)
      .map((row) => attachmentForRow(row, config))
)

export const get = wrapDb("attachments.get", (db, id, config) => {
  const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id)
  return row ? attachmentForRow(row, config) : undefined
})

export const updateProjection = wrapDb(
  "attachments.updateProjection",
  (db, id, data, config) => {
    const row = db.prepare("SELECT * FROM attachments WHERE id = ?").get(id)
    if (!row) throw new Error(`Attachment ${id} not found`)
    if (
      typeof data.content !== "string" ||
      typeof data.important !== "boolean" ||
      (data.noteColor !== null && !NOTE_COLORS.has(data.noteColor)) ||
      typeof data.createdAt !== "string" ||
      Number.isNaN(new Date(data.createdAt).getTime()) ||
      (data.exifData !== null || typeof data.exifData === "object") === false ||
      Array.isArray(data.exifData) ||
      !Number.isFinite(data.byteSize) ||
      data.byteSize < 0 ||
      !Number.isFinite(data.mtimeMs)
    ) {
      throw new Error("Invalid attachment projection")
    }
    db.prepare(
      `UPDATE attachments
        SET content = ?, important = ?, note_color = ?, exif_data = ?,
            created_at = ?, byte_size = ?, mtime_ms = ?, source_revision = NULL
        WHERE id = ?`
    ).run(
      data.content,
      Number(data.important),
      data.noteColor,
      data.exifData ? JSON.stringify(data.exifData) : null,
      data.createdAt,
      data.byteSize,
      data.mtimeMs,
      id
    )
    return get(db, id, config)
  }
)

export const listGeo = wrapDb("attachments.listGeo", (db, opts = {}, config) =>
  allRows(db)
    .filter(mediaVisual)
    .filter((row) => rowIsVisible(row, opts))
    .map((row) => summarize(row, config))
    .filter((row) => row.latitude != null && row.longitude != null)
    .sort((left, right) => right.created_at.localeCompare(left.created_at))
)

export const listNoGps = wrapDb(
  "attachments.listNoGps",
  (db, opts = {}, config) =>
    allRows(db)
      .filter(mediaVisual)
      .filter((row) => rowIsVisible(row, opts))
      .map((row) => summarize(row, config))
      .filter((row) => row.latitude == null || row.longitude == null)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
)

export const listMissingDateTimeOriginal = wrapDb(
  "attachments.listMissingDateTimeOriginal",
  (db, opts = {}, config) =>
    allRows(db)
      .filter((row) => row.mime_type.startsWith("image/"))
      .filter((row) => rowIsVisible(row, opts))
      .map((row) => summarize(row, config))
      .filter((row) => !row.exif_data?.DateTimeOriginal)
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
)

export const listMissingImported = wrapDb(
  "attachments.listMissingImported",
  (db, opts = {}, config) =>
    allRows(db)
      .filter(mediaVisual)
      .filter((row) => rowIsVisible(row, opts))
      .map((row) => summarize(row, config))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
)

export const listForRange = wrapDb(
  "attachments.listForRange",
  (db, startDate, endDate, opts = {}, config) =>
    db
      .prepare(
        `SELECT * FROM attachments
          WHERE created_at >= ? AND created_at < date(?, '+1 day')
          ORDER BY created_at`
      )
      .all(startDate, endDate)
      .filter(mediaVisual)
      .filter((row) => rowIsVisible(row, opts))
      .map((row) => summarize(row, config))
)
