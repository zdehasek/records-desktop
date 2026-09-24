import fs from "node:fs"
import * as attachments from "../repositories/attachments.js"
import * as messages from "../repositories/messages.js"
import { runTransaction } from "../db/transaction.js"
import { readMediaCompanion, writeMediaCompanion } from "./media-companion.js"

const NOTE_COLORS = new Set([
  "white",
  "butter",
  "blush",
  "mint",
  "sky",
  "lavender"
])
const FIELDS = new Set([
  "content",
  "important",
  "noteColor",
  "createdAt",
  "Make",
  "Model",
  "latitude",
  "longitude"
])
const IMAGE_FIELDS = ["Make", "Model", "latitude", "longitude"]
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?$/

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return false
  const match = TIMESTAMP_RE.exec(value)
  if (!match || Number.isNaN(new Date(value).getTime())) return false
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second = "0",
    ,
    ,
    offsetHour,
    offsetMinute
  ] = match
  const maximumDay = new Date(
    Date.UTC(Number(year), Number(month), 0)
  ).getUTCDate()
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= maximumDay &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (!offsetHour || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59))
  )
}

function validateGps(patch) {
  const hasLatitude = Object.hasOwn(patch, "latitude")
  const hasLongitude = Object.hasOwn(patch, "longitude")
  if (hasLatitude !== hasLongitude) {
    throw new Error("GPS latitude and longitude must be provided together")
  }
  if (!hasLatitude) return
  if (patch.latitude === null && patch.longitude === null) return
  if (patch.latitude === null || patch.longitude === null) {
    throw new Error("GPS latitude and longitude must both be null or numbers")
  }
  if (
    !Number.isFinite(patch.latitude) ||
    patch.latitude < -90 ||
    patch.latitude > 90
  ) {
    throw new Error("Latitude must be a finite number between -90 and 90")
  }
  if (
    !Number.isFinite(patch.longitude) ||
    patch.longitude < -180 ||
    patch.longitude > 180
  ) {
    throw new Error("Longitude must be a finite number between -180 and 180")
  }
}

export function validateMediaUpdate(requested) {
  if (!isPlainObject(requested))
    throw new Error("Media fields must be an object")
  const keys = Object.keys(requested)
  if (!keys.length) throw new Error("Media fields must not be empty")
  const unknown = keys.filter((key) => !FIELDS.has(key))
  if (unknown.length) {
    throw new Error(`Unsupported media fields: ${unknown.join(", ")}`)
  }
  if (
    Object.values(requested).some(
      (value) => typeof value === "string" && value.includes("\0")
    )
  ) {
    throw new Error("Media fields cannot contain NUL characters")
  }
  if (
    Object.hasOwn(requested, "content") &&
    typeof requested.content !== "string"
  ) {
    throw new Error("Media content must be a string")
  }
  if (
    Object.hasOwn(requested, "important") &&
    typeof requested.important !== "boolean"
  ) {
    throw new Error("Media important must be a boolean")
  }
  if (
    Object.hasOwn(requested, "noteColor") &&
    requested.noteColor !== null &&
    !NOTE_COLORS.has(requested.noteColor)
  ) {
    throw new Error("Invalid note color")
  }
  if (
    Object.hasOwn(requested, "createdAt") &&
    !validTimestamp(requested.createdAt)
  ) {
    throw new Error(
      "Media createdAt must be a valid non-empty timestamp string"
    )
  }
  for (const field of ["Make", "Model"]) {
    if (
      Object.hasOwn(requested, field) &&
      requested[field] !== null &&
      typeof requested[field] !== "string"
    ) {
      throw new Error(`${field} must be a string or null`)
    }
  }
  validateGps(requested)
  return { ...requested }
}

function validateTarget(attachment, patch) {
  const image = attachment.mime_type?.startsWith("image/")
  const video = attachment.mime_type?.startsWith("video/")
  if (!image && !video) throw new Error("Unsupported media type")
  if (video && IMAGE_FIELDS.some((field) => Object.hasOwn(patch, field))) {
    throw new Error("This metadata field is only supported for images")
  }
  let stat
  try {
    stat = fs.lstatSync(attachment.file_path)
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("Attachment file is missing")
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error("symlink items are view-only")
  if (!stat.isFile())
    throw new Error("Attachment target must be a regular file")
  return image
}

function imagePatch(patch) {
  return {
    ...(Object.hasOwn(patch, "content") && { caption: patch.content }),
    ...(Object.hasOwn(patch, "important") && { important: patch.important }),
    ...(Object.hasOwn(patch, "noteColor") && {
      presentationColor: patch.noteColor
    }),
    ...(Object.hasOwn(patch, "createdAt") && { createdAt: patch.createdAt }),
    ...(Object.hasOwn(patch, "Make") && { make: patch.Make }),
    ...(Object.hasOwn(patch, "Model") && { model: patch.Model }),
    ...(Object.hasOwn(patch, "latitude") && {
      latitude: patch.latitude,
      longitude: patch.longitude
    })
  }
}

function captureFields(value) {
  const match = TIMESTAMP_RE.exec(value)
  return {
    dateTimeOriginal: `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6] || "00"}`,
    offsetTimeOriginal: value.endsWith("Z")
      ? "+00:00"
      : match[9]
        ? `${match[8]}${match[9]}:${match[10]}`
        : null
  }
}

function updatedExif(current, patch, embedded) {
  const exif = { ...(current || {}) }
  if (Object.hasOwn(patch, "content") && embedded?.values) {
    for (const [field, value] of [
      ["Description", embedded.values.xmp],
      ["CaptionAbstract", embedded.values.iptc],
      ["ImageDescription", embedded.values.exif]
    ]) {
      if (value) exif[field] = value
      else delete exif[field]
    }
  }
  for (const field of ["Make", "Model"]) {
    if (!Object.hasOwn(patch, field)) continue
    if (patch[field]) exif[field] = patch[field]
    else delete exif[field]
  }
  if (Object.hasOwn(patch, "createdAt")) {
    const capture = embedded?.dateTimeOriginal
      ? embedded
      : captureFields(patch.createdAt)
    exif.DateTimeOriginal = capture.dateTimeOriginal
    if (capture.offsetTimeOriginal) {
      exif.OffsetTimeOriginal = capture.offsetTimeOriginal
    } else {
      delete exif.OffsetTimeOriginal
    }
  }
  if (Object.hasOwn(patch, "latitude")) {
    if (patch.latitude === null) {
      delete exif.latitude
      delete exif.longitude
    } else {
      exif.latitude = patch.latitude
      exif.longitude = patch.longitude
    }
  }
  return Object.keys(exif).length ? exif : null
}

function projectedContent(message, patch, companion, embedded) {
  if (companion) return companion.content
  if (!Object.hasOwn(patch, "content")) return message.content
  return embedded?.caption ?? patch.content
}

function projectedImportant(message, patch, companion, embedded) {
  if (companion) return companion.metadata.important === true
  if (!Object.hasOwn(patch, "important")) {
    return message.metadata?.important === true
  }
  return embedded?.important ?? patch.important
}

function projectedColor(message, patch, companion, embedded) {
  if (companion) return companion.metadata.note_style?.color || null
  if (!Object.hasOwn(patch, "noteColor")) {
    return message.metadata?.note_style?.color || null
  }
  return embedded?.presentationColor ?? patch.noteColor
}

function projectedCreatedAt(attachment, patch, companion, embedded) {
  if (companion?.metadata.date_override) {
    return companion.metadata.date_override
  }
  if (!Object.hasOwn(patch, "createdAt")) return attachment.created_at
  return embedded?.createdAt ?? patch.createdAt
}

function projectionFor(
  attachment,
  message,
  patch,
  exifData,
  companion,
  embedded
) {
  const stat = fs.statSync(attachment.file_path)
  const companionFile = `${attachment.file_path}.md`
  const mtimeMs = fs.existsSync(companionFile)
    ? Math.max(stat.mtimeMs, fs.statSync(companionFile).mtimeMs)
    : stat.mtimeMs
  return {
    content: projectedContent(message, patch, companion, embedded),
    important: projectedImportant(message, patch, companion, embedded),
    noteColor: projectedColor(message, patch, companion, embedded),
    createdAt: projectedCreatedAt(attachment, patch, companion, embedded),
    exifData,
    byteSize: stat.size,
    mtimeMs
  }
}

export async function updateMediaAttachment(db, id, requested, options) {
  const patch = validateMediaUpdate(requested)
  const attachment = attachments.get(db, id, options.config)
  if (!attachment) throw new Error("Attachment not found")
  const message = messages.get(db, attachment.message_id)
  const image = validateTarget(attachment, patch)
  let exifData = attachment.exif_data
  let writtenCompanion = null
  let embedded = null

  if (image) {
    const result = await options.captionMetadata.write(
      attachment.file_path,
      imagePatch(patch)
    )
    embedded = result.embedded
    exifData = updatedExif(exifData, patch, embedded)
  } else {
    const readCompanion = options.readMediaCompanion || readMediaCompanion
    const writeCompanion = options.writeMediaCompanion || writeMediaCompanion
    const current = readCompanion(attachment.file_path)
    writtenCompanion = writeCompanion(
      attachment.file_path,
      {
        ...(current?.metadata || {}),
        ...(Object.hasOwn(patch, "important") && {
          important: patch.important
        }),
        ...(Object.hasOwn(patch, "noteColor") && {
          note_style: patch.noteColor ? { color: patch.noteColor } : null
        }),
        ...(Object.hasOwn(patch, "createdAt") && {
          date_override: patch.createdAt
        })
      },
      Object.hasOwn(patch, "content")
        ? patch.content
        : (current?.content ?? message.content),
      { expectedRevision: current?.revision ?? null }
    )
  }

  const projection = projectionFor(
    attachment,
    message,
    patch,
    exifData,
    writtenCompanion,
    embedded
  )
  const updated = runTransaction(db, () =>
    attachments.updateProjection(db, id, projection, options.config)
  )
  if (image) options.thumbnails?.invalidate?.(updated)
  return updated
}
