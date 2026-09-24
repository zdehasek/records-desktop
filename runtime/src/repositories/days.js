import { wrapDb } from "../db/repo-helpers.js"
import { attachmentForRow, messageForRow, rowIsVisible } from "./media-row.js"

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(value) {
  if (!DATE.test(value) || value.startsWith("0000-")) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  )
}

function normalizeDate(value) {
  const date = String(value || "").slice(0, 10)
  if (!validDate(date)) {
    throw new Error(`Invalid day date: ${value}`)
  }
  return date
}

function nextDate(date) {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

function visibilitySql(opts = {}) {
  return [
    opts.dotFilesVisible ? "" : "AND relative_path NOT GLOB '.hidden/*/*'",
    opts.nsfwMode === "hidden" ? "AND relative_path NOT GLOB '.nsfw/*/*'" : ""
  ]
    .filter(Boolean)
    .join(" ")
}

function earliestVisibleDate(db, opts = {}) {
  const rows = db
    .prepare(
      `SELECT DISTINCT substr(created_at, 1, 10) AS date
         FROM attachments
        WHERE created_at >= '0001-01-01' ${visibilitySql(opts)}
        ORDER BY date`
    )
    .all()
  return rows.find((row) => validDate(row.date))?.date || null
}

function rowsForDate(db, date, opts = {}) {
  return db
    .prepare(
      `SELECT * FROM attachments
        WHERE created_at >= ? AND created_at < ?
        ORDER BY created_at, id`
    )
    .all(date, nextDate(date))
    .filter((row) => rowIsVisible(row, opts))
}

function isVisualMedia(row) {
  return (
    row.mime_type.startsWith("image/") || row.mime_type.startsWith("video/")
  )
}

function dayDtoFromRows(date, rows, opts = {}) {
  const importantMedia = rows.filter(
    (row) => row.important && isVisualMedia(row)
  )
  const fallbackPhoto = opts.autoPhoto
    ? rows.find((row) => row.mime_type.startsWith("image/"))
    : null
  const featured = importantMedia.length
    ? importantMedia[Math.floor(Math.random() * importantMedia.length)].id
    : fallbackPhoto?.id || null
  return {
    id: date,
    date,
    created_at: `${date}T00:00:00.000Z`,
    updated_at: `${date}T00:00:00.000Z`,
    photo_attachment_id: featured,
    photo_count: rows.filter((row) => isVisualMedia(row)).length
  }
}

function dayDto(db, date, opts = {}) {
  return dayDtoFromRows(date, rowsForDate(db, date, opts), opts)
}

function daySummaries(db, opts = {}, range = null) {
  const visibility = visibilitySql(opts)
  const lower = range?.start || "0001-01-01"
  const upper = range ? "AND created_at < ?" : ""
  const args = range ? [lower, nextDate(range.end)] : [lower]
  const direction = range ? "ASC" : "DESC"
  return db
    .prepare(
      `SELECT substr(created_at, 1, 10) AS date,
              COUNT(CASE
                WHEN mime_type LIKE 'image/%' OR mime_type LIKE 'video/%'
                THEN 1
              END) AS photo_count,
              json_group_array(id ORDER BY created_at, id) FILTER (
                WHERE important != 0 AND
                      (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')
              ) AS important_media_ids,
              json_extract(
                json_group_array(id ORDER BY created_at, id) FILTER (
                  WHERE mime_type LIKE 'image/%'
                ),
                '$[0]'
              ) AS fallback_photo_id
         FROM attachments
        WHERE created_at >= ? ${upper} ${visibility}
        GROUP BY substr(created_at, 1, 10)
        ORDER BY date ${direction}`
    )
    .all(...args)
    .filter((row) => validDate(row.date))
    .map((row) => {
      const importantMediaIds = JSON.parse(row.important_media_ids)
      const importantMediaId = importantMediaIds.length
        ? importantMediaIds[
            Math.floor(Math.random() * importantMediaIds.length)
          ]
        : null
      return {
        id: row.date,
        date: row.date,
        created_at: `${row.date}T00:00:00.000Z`,
        updated_at: `${row.date}T00:00:00.000Z`,
        photo_attachment_id:
          importantMediaId || (opts.autoPhoto ? row.fallback_photo_id : null),
        photo_count: row.photo_count
      }
    })
}

const lastDayOfMonth = (year, month) =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate()

function memoryDates(targetDate, earliestDate) {
  const target = new Date(`${targetDate}T00:00:00Z`)
  const result = []
  for (let monthsAgo = 1; monthsAgo <= 11; monthsAgo += 1) {
    const total =
      target.getUTCFullYear() * 12 + target.getUTCMonth() - monthsAgo
    const year = Math.floor(total / 12)
    const month = total % 12
    const day = Math.min(target.getUTCDate(), lastDayOfMonth(year, month))
    const date = new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10)
    if (date >= earliestDate)
      result.push({ date, label: `${monthsAgo}M`, period: `${monthsAgo}m` })
  }
  for (
    let year = target.getUTCFullYear() - 1;
    year >= Number(earliestDate.slice(0, 4));
    year -= 1
  ) {
    const day = Math.min(
      target.getUTCDate(),
      lastDayOfMonth(year, target.getUTCMonth())
    )
    const date = new Date(Date.UTC(year, target.getUTCMonth(), day))
      .toISOString()
      .slice(0, 10)
    if (date >= earliestDate) {
      const years = target.getUTCFullYear() - year
      result.push({ date, label: `${years}Y`, period: `${years}y` })
    }
  }
  return result
}

export const memory = wrapDb("days.memory", (db, targetDate, opts = {}) => {
  if (!targetDate) return []
  const target = normalizeDate(targetDate)
  const configuredEarliest = String(opts.earliestDate || "").slice(0, 10)
  const earliestValue = validDate(configuredEarliest)
    ? configuredEarliest
    : earliestVisibleDate(db, opts)
  const earliestDate = String(earliestValue || "").slice(0, 10)
  if (!validDate(earliestDate)) return []

  return memoryDates(target, earliestDate)
    .map((candidate) => {
      const day = dayDto(db, candidate.date, opts)
      return day.photo_count ? { ...day, ...candidate } : null
    })
    .filter(Boolean)
})

export const ensure = wrapDb("days.ensure", (_db, value) => {
  const date = normalizeDate(value)
  return dayDto(_db, date)
})

export const get = wrapDb("days.get", (db, id, opts = {}) =>
  dayDto(db, normalizeDate(id), opts)
)

export const listWithContent = wrapDb("days.listWithContent", (db, opts = {}) =>
  daySummaries(db, opts)
)

export const listForRange = wrapDb(
  "days.listForRange",
  (db, startDate, endDate, opts = {}) => {
    const start = normalizeDate(startDate)
    const end = normalizeDate(endDate)
    if (end < start) return []
    return daySummaries(db, opts, { start, end })
  }
)

export const storyItems = wrapDb(
  "days.storyItems",
  (db, targetDate, opts = {}, config) => {
    const memories = memory(db, targetDate, opts).sort((left, right) =>
      left.date.localeCompare(right.date)
    )
    if (!memories.length) return []
    const result = []
    for (const label of memories) {
      const date = label.date
      const rows = rowsForDate(db, date, opts)
      const important = rows.filter((row) => row.important)
      const photos = important.filter((row) =>
        row.mime_type.startsWith("image/")
      )
      const cover = photos.length
        ? photos[Math.floor(Math.random() * photos.length)]
        : opts.autoPhoto
          ? rows.find((row) => row.mime_type.startsWith("image/"))
          : null
      const selected =
        cover && !important.some((row) => row.id === cover.id)
          ? [cover, ...important]
          : important
      for (const row of selected) {
        result.push({
          day: { id: date, date, label: label.label, period: label.period },
          message: messageForRow(row),
          attachment: attachmentForRow(row, config),
          isCover: row.id === cover?.id,
          isImportant: Boolean(row.important)
        })
      }
    }
    return result
  }
)
