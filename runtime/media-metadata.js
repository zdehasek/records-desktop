import path from "node:path"
import { runCommand } from "./host-tools.js"
import {
  resolveMediaTool,
  toolArgs,
  toolCommand,
  toolOptions
} from "./media-tools.js"

const magick = resolveMediaTool("magick")
const ffprobe = resolveMediaTool("ffprobe")

function rational(value) {
  const parts = String(value || "")
    .trim()
    .split(/[ ,]+/)
  const numbers = parts.map((part) => {
    const [a, b] = part.split("/").map(Number)
    return b ? a / b : a
  })
  if (numbers.length < 3 || numbers.some(Number.isNaN)) return null
  return numbers[0] + numbers[1] / 60 + numbers[2] / 3600
}

function exifDate(value, offset = null) {
  const match =
    /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/.exec(
      value || ""
    )
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > maximumDay ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  ) {
    return null
  }
  const normalizedOffset = /^(?:Z|[+-]\d{2}:\d{2})$/i.test(offset || "")
    ? offset.toUpperCase() === "Z"
      ? "+00:00"
      : offset
    : ""
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7] || ""}${normalizedOffset}`
}

const VIDEO_EXTENSIONS = /^\.(avi|m4v|mkv|mov|mp4|webm)$/
const NOTE_COLORS = new Set([
  "white",
  "butter",
  "blush",
  "mint",
  "sky",
  "lavender"
])

export function normalizeNoteColor(value) {
  return typeof value === "string" && NOTE_COLORS.has(value) ? value : null
}

function normalizedDuration(value) {
  if (value == null || String(value).trim() === "") return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

function durationSeconds(data) {
  const formatDuration = normalizedDuration(data.format?.duration)
  if (formatDuration != null) return formatDuration
  const streamDurations = (data.streams || [])
    .map((stream) => normalizedDuration(stream.duration))
    .filter((value) => value != null)
  return streamDurations.length ? Math.max(...streamDurations) : null
}

function timestamp(value) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function iso6709Component(raw, degreeDigits) {
  const sign = raw[0] === "-" ? -1 : 1
  const absolute = raw.slice(1)
  const integer = absolute.split(".")[0]
  if (integer.length <= degreeDigits) return sign * Number(absolute)
  const degrees = Number(absolute.slice(0, degreeDigits))
  if (integer.length <= degreeDigits + 2) {
    return sign * (degrees + Number(absolute.slice(degreeDigits)) / 60)
  }
  const minutes = Number(absolute.slice(degreeDigits, degreeDigits + 2))
  const seconds = Number(absolute.slice(degreeDigits + 2))
  return sign * (degrees + minutes / 60 + seconds / 3600)
}

function iso6709(value) {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(value || "")
  if (!match) return { latitude: null, longitude: null }
  const latitude = iso6709Component(match[1], 2)
  const longitude = iso6709Component(match[2], 3)
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return { latitude: null, longitude: null }
  }
  return { latitude, longitude }
}

export class UnsupportedMediaError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = "UnsupportedMediaError"
    this.code = "UNSUPPORTED_MEDIA"
    this.reason = options?.reason || "probe-failed"
    this.retryable = this.reason !== "no-video-stream"
  }
}

async function probeVideo(filePath) {
  if (!ffprobe) {
    throw new UnsupportedMediaError(
      "FFprobe is required to verify video files",
      {
        reason: "probe-unavailable"
      }
    )
  }
  try {
    const { stdout } = await runCommand(
      toolCommand(ffprobe),
      toolArgs(ffprobe, [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        filePath
      ]),
      toolOptions(ffprobe)
    )
    return JSON.parse(stdout)
  } catch (error) {
    throw new UnsupportedMediaError("File could not be verified as video", {
      cause: error,
      reason: "probe-failed"
    })
  }
}

function validateVideoProbe(data) {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray(data.streams) ||
    data.streams.some(
      (stream) => !stream || typeof stream !== "object" || Array.isArray(stream)
    )
  ) {
    throw new UnsupportedMediaError(
      "Video probe returned invalid stream data",
      {
        reason: "invalid-probe"
      }
    )
  }
  if (!data.streams.some((stream) => stream.codec_type === "video")) {
    throw new UnsupportedMediaError("File does not contain a video stream", {
      reason: "no-video-stream"
    })
  }
}

function videoCreatedAt(data, tags) {
  const streamTime = data.streams.find(
    (stream) => stream.codec_type === "video" && stream.tags?.creation_time
  )?.tags.creation_time
  return timestamp(
    tags["com.apple.quicktime.creationdate"] || tags.creation_time || streamTime
  )
}

async function readVideoMetadata(filePath) {
  const data = await probeVideo(filePath)
  validateVideoProbe(data)
  const tags = data.format?.tags || {}
  const createdAt = videoCreatedAt(data, tags)
  const { latitude, longitude } = iso6709(
    tags["com.apple.quicktime.location.ISO6709"] ||
      tags.location ||
      tags["location-eng"]
  )
  const make = tags["com.apple.quicktime.make"] || tags.make || null
  const model = tags["com.apple.quicktime.model"] || tags.model || null
  return {
    exifData: {
      ...(createdAt && { DateTimeOriginal: createdAt }),
      ...(make && { Make: make.trim() }),
      ...(model && { Model: model.trim() })
    },
    createdAt,
    durationSeconds: durationSeconds(data),
    mediaType: "video",
    latitude,
    longitude
  }
}

function imageExifData({ date, make, model, latitude, longitude, caption }) {
  const authoritativeDate = caption?.dateTimeOriginal || date
  const authoritativeMake = caption?.make || make
  const authoritativeModel = caption?.model || model
  return {
    ...(authoritativeDate && { DateTimeOriginal: authoritativeDate }),
    ...(caption?.offsetTimeOriginal && {
      OffsetTimeOriginal: caption.offsetTimeOriginal
    }),
    ...(authoritativeMake && { Make: authoritativeMake.trim() }),
    ...(authoritativeModel && { Model: authoritativeModel.trim() }),
    ...(latitude != null && { latitude }),
    ...(longitude != null && { longitude }),
    ...(caption && {
      Description: caption.values.xmp || undefined,
      CaptionAbstract: caption.values.iptc || undefined,
      ImageDescription: caption.values.exif || undefined
    })
  }
}

function resolvedImageMetadata(raw, caption) {
  const authoritativeDate = caption?.dateTimeOriginal || raw.date
  const latitude = caption?.latitude ?? raw.latitude
  const longitude = caption?.longitude ?? raw.longitude
  return {
    exifData: imageExifData({
      ...raw,
      date: authoritativeDate,
      latitude,
      longitude,
      caption
    }),
    createdAt:
      caption?.createdAt ||
      exifDate(authoritativeDate, caption?.offsetTimeOriginal) ||
      raw.createdAt,
    latitude,
    longitude,
    caption: caption?.caption ?? null,
    captionConflict: caption?.conflict || false,
    important: caption?.important || false,
    presentationColor: caption?.presentationColor || null
  }
}

async function readImageMetadata(filePath, captionMetadata) {
  const format = [
    "%[EXIF:DateTimeOriginal]",
    "%[EXIF:Make]",
    "%[EXIF:Model]",
    "%[EXIF:GPSLatitude]",
    "%[EXIF:GPSLatitudeRef]",
    "%[EXIF:GPSLongitude]",
    "%[EXIF:GPSLongitudeRef]"
  ].join("\u001f")
  const args = ["-quiet", "-format", format, `${filePath}[0]`]
  if (!magick.operations?.identify) args.unshift("identify")
  const { stdout } = await runCommand(
    toolCommand(magick, "identify"),
    toolArgs(magick, args, "identify"),
    toolOptions(magick)
  )
  const [date, make, model, rawLat, latRef, rawLon, lonRef] =
    stdout.split("\u001f")
  let latitude = rational(rawLat)
  let longitude = rational(rawLon)
  if (latitude != null && /S/i.test(latRef)) latitude *= -1
  if (longitude != null && /W/i.test(lonRef)) longitude *= -1
  const createdAt = exifDate(date)
  const caption = captionMetadata ? await captionMetadata.read(filePath) : null
  return resolvedImageMetadata(
    { date, make, model, latitude, longitude, createdAt },
    caption
  )
}

export async function readMediaMetadata(filePath, options = {}) {
  const extension = path.extname(filePath).toLowerCase()
  if (VIDEO_EXTENSIONS.test(extension)) {
    return readVideoMetadata(filePath)
  }
  if (!magick) {
    throw new Error("ImageMagick is required to read image metadata")
  }
  return readImageMetadata(filePath, options.captionMetadata)
}

export function resolveMediaMimeType(fallback, metadata = {}) {
  if (!metadata.mediaType || fallback.startsWith(`${metadata.mediaType}/`)) {
    return fallback
  }
  const subtype = fallback.split("/")[1]
  return subtype ? `${metadata.mediaType}/${subtype}` : fallback
}

export function resolveMediaCreatedAt(metadata, fallback, override = null) {
  return override || metadata.createdAt || fallback
}

export function projectMessageMetadata(metadata = {}, durable = {}) {
  const noteColor = normalizeNoteColor(
    durable.noteColor || durable.presentationColor
  )
  return {
    ...(Number.isFinite(metadata.durationSeconds) && {
      duration_seconds: metadata.durationSeconds
    }),
    ...(durable.important === true && { important: true }),
    ...(noteColor && {
      note_style: { color: noteColor }
    })
  }
}
