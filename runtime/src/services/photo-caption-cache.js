import { filePathForRow } from "../repositories/media-row.js"
import { runTransaction } from "../db/transaction.js"
import { normalizeNoteColor } from "../../media-metadata.js"

function sourceRows(db, dayId) {
  const condition =
    dayId == null
      ? ""
      : " AND created_at >= ? AND created_at < date(?, '+1 day')"
  return db
    .prepare(
      `SELECT * FROM attachments
        WHERE mime_type LIKE 'image/%'${condition}
        ORDER BY created_at, id`
    )
    .all(...(dayId == null ? [] : [String(dayId), String(dayId)]))
}

export async function reconcilePhotoCaptions(
  db,
  captionMetadata,
  options = {}
) {
  if (!captionMetadata?.capabilities().read) {
    return { checked: 0, updated: 0, conflicts: 0, errors: [] }
  }
  let checked = 0
  let updated = 0
  let conflicts = 0
  const errors = []
  const updates = []
  for (const row of sourceRows(db, options.dayId)) {
    checked += 1
    try {
      const embedded = await captionMetadata.read(
        filePathForRow(row, options.config)
      )
      if (embedded.conflict) {
        conflicts += 1
        continue
      }
      const exif = { ...(row.exif_data ? JSON.parse(row.exif_data) : {}) }
      for (const [key, value] of [
        ["Description", embedded.values.xmp],
        ["CaptionAbstract", embedded.values.iptc],
        ["ImageDescription", embedded.values.exif]
      ]) {
        if (value) exif[key] = value
        else delete exif[key]
      }
      const nextColor = normalizeNoteColor(embedded.presentationColor)
      const nextExif = Object.keys(exif).length ? JSON.stringify(exif) : null
      if (
        row.content !== embedded.caption ||
        Boolean(row.important) !== embedded.important ||
        row.note_color !== nextColor ||
        row.exif_data !== nextExif
      ) {
        updates.push([
          embedded.caption,
          embedded.important ? 1 : 0,
          nextColor,
          nextExif,
          row.id
        ])
        updated += 1
      }
    } catch (error) {
      errors.push({ attachmentId: row.id, error: error.message })
    }
  }
  runTransaction(db, () => {
    const update = db.prepare(
      `UPDATE attachments
          SET content = ?, important = ?, note_color = ?, exif_data = ?,
              source_revision = NULL
        WHERE id = ?`
    )
    for (const values of updates) update.run(...values)
  })
  return { checked, updated, conflicts, errors }
}
