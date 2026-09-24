import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { findCommand, runCommand } from "../../host-tools.js"
import { normalizeNoteColor } from "../../media-metadata.js"

const CAPTION_TAGS = [
  "XMP-dc:Description",
  "IPTC:Caption-Abstract",
  "EXIF:ImageDescription"
]
const METADATA_TAGS = [
  ...CAPTION_TAGS,
  "XMP-records:Important",
  "XMP-records:PresentationColor",
  "XMP-xmp:CreateDate",
  "EXIF:DateTimeOriginal",
  "EXIF:OffsetTimeOriginal",
  "EXIF:Make",
  "EXIF:Model",
  "Composite:GPSLatitude",
  "Composite:GPSLongitude"
]
const EXIFTOOL_CONFIG = path.join(import.meta.dirname, "exiftool.config")

function captionText(value) {
  if (value == null) return ""
  if (typeof value === "string" || typeof value === "number") {
    return String(value).replace(/\r\n?/g, "\n").replace(/\0+$/g, "")
  }
  if (Array.isArray(value)) {
    return captionText(value.find((item) => captionText(item)) || "")
  }
  if (typeof value === "object") {
    return captionText(
      value["x-default"] ||
        value.xDefault ||
        Object.values(value).find((item) => captionText(item)) ||
        ""
    )
  }
  return ""
}

function valueForSuffix(data, suffix) {
  const entry = Object.entries(data || {}).find(([key]) =>
    key.toLowerCase().endsWith(suffix.toLowerCase())
  )
  return captionText(entry?.[1])
}

const groupedValue = (data, group, tag) => {
  const expected = `${group}:${tag}`.toLowerCase()
  const exact = Object.entries(data || {}).find(
    ([key]) => key.toLowerCase() === expected
  )?.[1]
  if (exact !== undefined || group !== "EXIF") return exact
  return Object.entries(data || {}).find(([key]) => {
    const [actualGroup, actualTag] = key.split(":")
    return (
      /^(?:ExifIFD|IFD\d+)$/i.test(actualGroup) &&
      actualTag?.toLowerCase() === tag.toLowerCase()
    )
  })?.[1]
}

export function resolveCaptionTags(data) {
  const values = {
    xmp: valueForSuffix(data, "Description"),
    iptc: valueForSuffix(data, "Caption-Abstract"),
    exif: valueForSuffix(data, "ImageDescription")
  }
  // Description may otherwise match ImageDescription. Prefer a grouped XMP key.
  const xmpEntry = Object.entries(data || {}).find(([key]) =>
    /^XMP[^:]*:Description$/i.test(key)
  )
  values.xmp = captionText(xmpEntry?.[1])

  const populated = Object.values(values).filter(Boolean)
  return {
    caption: values.xmp || values.iptc || values.exif || "",
    source: values.xmp
      ? "xmp"
      : values.iptc
        ? "iptc"
        : values.exif
          ? "exif"
          : null,
    conflict: new Set(populated).size > 1,
    values
  }
}

export function resolveImageMetadata(data) {
  const caption = resolveCaptionTags(data)
  const latitudeValue = groupedValue(data, "Composite", "GPSLatitude")
  const longitudeValue = groupedValue(data, "Composite", "GPSLongitude")
  const importantValue = groupedValue(data, "XMP-records", "Important")
  const dateTimeOriginal =
    captionText(groupedValue(data, "EXIF", "DateTimeOriginal")) || null
  const offsetTimeOriginal =
    captionText(groupedValue(data, "EXIF", "OffsetTimeOriginal")) || null
  const xmpCreateDate =
    captionText(groupedValue(data, "XMP-xmp", "CreateDate")) || null
  const exifCreatedAt = captureTimestamp(dateTimeOriginal, offsetTimeOriginal)
  const normalizedXmpCreateDate = xmpCreateDate
    ? normalizedTimestamp(xmpCreateDate)
    : null
  if (
    normalizedXmpCreateDate &&
    exifCreatedAt &&
    !captureTimesAgree(normalizedXmpCreateDate, exifCreatedAt)
  ) {
    throw new Error("Photo XMP and EXIF capture times disagree")
  }
  const createdAt = normalizedXmpCreateDate
    ? timestampWithFallbackOffset(normalizedXmpCreateDate, exifCreatedAt)
    : exifCreatedAt
  return {
    ...caption,
    important:
      importantValue === true ||
      /^(true|1)$/i.test(String(importantValue || "")),
    presentationColor: normalizeNoteColor(
      captionText(groupedValue(data, "XMP-records", "PresentationColor"))
    ),
    dateTimeOriginal,
    offsetTimeOriginal,
    xmpCreateDate,
    createdAt,
    make: captionText(groupedValue(data, "EXIF", "Make")) || null,
    model: captionText(groupedValue(data, "EXIF", "Model")) || null,
    latitude:
      latitudeValue != null &&
      latitudeValue !== "" &&
      Number.isFinite(Number(latitudeValue))
        ? Number(latitudeValue)
        : null,
    longitude:
      longitudeValue != null &&
      longitudeValue !== "" &&
      Number.isFinite(Number(longitudeValue))
        ? Number(longitudeValue)
        : null
  }
}

export function captureTimestamp(dateTimeOriginal, offsetTimeOriginal = null) {
  const match = captureParts(dateTimeOriginal)
  if (!match) return null
  const offset = /^(?:Z|[+-]\d{2}:\d{2})$/i.test(offsetTimeOriginal || "")
    ? offsetTimeOriginal.toUpperCase() === "Z"
      ? "+00:00"
      : offsetTimeOriginal
    : ""
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}${match[7] || ""}${offset}`
}

function captureParts(value) {
  const datePrefix = /^\d{4}([:-])\d{2}\1\d{2}/.exec(value || "")
  if (!datePrefix) return null
  const match =
    /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      value || ""
    )
  if (!match) return null
  const maximumDay = new Date(
    Date.UTC(Number(match[1]), Number(match[2]), 0)
  ).getUTCDate()
  if (
    Number(match[1]) < 1 ||
    Number(match[2]) < 1 ||
    Number(match[2]) > 12 ||
    Number(match[3]) < 1 ||
    Number(match[3]) > maximumDay ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (match[8] &&
      match[8] !== "Z" &&
      (Number(match[8].slice(1, 3)) > 23 || Number(match[8].slice(4, 6)) > 59))
  ) {
    return null
  }
  return match
}

function normalizedTimestamp(value) {
  const match = captureParts(value)
  if (!match) throw new Error("Photo XMP CreateDate is invalid")
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}${match[7] || ""}${match[8] || ""}`
}

function captureTimesAgree(xmp, exif) {
  if (!xmp || !exif) return false
  const exact = captureParts(xmp)
  const compatible = captureParts(exif)
  if (!exact || !compatible) return false
  const wallTimesAgree =
    [...exact.slice(1, 6), exact[6] || "00"].join("") ===
    [...compatible.slice(1, 6), compatible[6] || "00"].join("")
  const exactOffset = exact[8] === "Z" ? "+00:00" : exact[8] || ""
  const compatibleOffset =
    compatible[8] === "Z" ? "+00:00" : compatible[8] || ""
  return (
    wallTimesAgree &&
    (!exactOffset || !compatibleOffset || exactOffset === compatibleOffset)
  )
}

function timestampWithFallbackOffset(timestamp, fallback) {
  const primary = captureParts(timestamp)
  const secondary = captureParts(fallback)
  if (!primary || primary[8] || !secondary?.[8]) return timestamp
  return `${timestamp}${secondary[8] === "Z" ? "+00:00" : secondary[8]}`
}

function parseExiftoolJson(stdout) {
  const rows = JSON.parse(stdout || "[]")
  return resolveImageMetadata(rows[0] || {})
}

function imageSignatures(stdout) {
  return String(stdout || "")
    .split("\u001e")
    .map((value) => value.trim())
    .filter(Boolean)
}

async function checksum(filePath) {
  const hash = createHash("sha256")
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", resolve)
  })
  return hash.digest("hex")
}

function sameFile(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  )
}

export function createImageCaptionMetadata(options = {}) {
  const exiftool =
    options.exiftool === undefined ? findCommand("exiftool") : options.exiftool
  const magick =
    options.magick === undefined ? findCommand("magick") : options.magick
  const run = options.runCommand || runCommand
  const calculateChecksum = options.checksum || checksum

  const capabilities = () => ({
    read: Boolean(exiftool),
    write: Boolean(exiftool && magick),
    tool: exiftool ? "exiftool" : null
  })

  async function read(filePath) {
    if (!exiftool)
      throw new Error("ExifTool is required to read photo captions")
    const { stdout } = await run(exiftool, [
      "-config",
      EXIFTOOL_CONFIG,
      "-j",
      "-G1",
      "-s",
      "-struct",
      "-n",
      ...METADATA_TAGS.map((tag) => `-${tag}`),
      filePath
    ])
    return parseExiftoolJson(stdout)
  }

  async function signatures(filePath) {
    if (!magick) {
      throw new Error("ImageMagick is required to verify photo pixels")
    }
    const { stdout } = await run(magick, [
      "identify",
      "-quiet",
      "-format",
      "%m\u001f%w\u001f%h\u001f%[scene]\u001f%[signature]\u001e",
      filePath
    ])
    const result = imageSignatures(stdout)
    if (!result.length) throw new Error("Photo verification produced no frames")
    return result
  }

  async function contentFingerprint(filePath) {
    return createHash("sha256")
      .update((await signatures(filePath)).join("\n"))
      .digest("hex")
  }

  const captureTime = (value) => {
    const match = captureParts(value)
    if (!match) throw new Error("Invalid capture time")
    return {
      exif: `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6] || "00"}`,
      offset: match[8] === "Z" ? "+00:00" : match[8] || null,
      xmp: normalizedTimestamp(value)
    }
  }

  const gpsArgs = ({ latitude, longitude }) => {
    if (latitude == null && longitude == null) {
      return ["-EXIF:GPSLatitude=", "-EXIF:GPSLongitude="]
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw new Error("GPS latitude and longitude must be provided together")
    }
    return [
      `-EXIF:GPSLatitude=${Math.abs(latitude)}`,
      `-EXIF:GPSLatitudeRef=${latitude < 0 ? "S" : "N"}`,
      `-EXIF:GPSLongitude=${Math.abs(longitude)}`,
      `-EXIF:GPSLongitudeRef=${longitude < 0 ? "W" : "E"}`
    ]
  }

  const writeArgs = (patch) => {
    const args = [
      "-config",
      EXIFTOOL_CONFIG,
      "-overwrite_original",
      "-charset",
      "iptc=utf8"
    ]
    if ("caption" in patch) {
      const caption = captionText(patch.caption)
      args.push(
        "-IPTC:CodedCharacterSet=UTF8",
        `-XMP-dc:Description=${caption}`,
        `-IPTC:Caption-Abstract=${caption}`,
        `-EXIF:ImageDescription=${caption}`
      )
    }
    if ("important" in patch) {
      args.push(`-XMP-records:Important=${patch.important ? "true" : "false"}`)
    }
    if ("presentationColor" in patch) {
      args.push(
        `-XMP-records:PresentationColor=${patch.presentationColor || ""}`
      )
    }
    if ("createdAt" in patch) {
      const capture = captureTime(patch.createdAt)
      args.push(`-EXIF:DateTimeOriginal=${capture.exif}`)
      args.push(`-EXIF:CreateDate=${capture.exif}`)
      args.push(`-EXIF:OffsetTimeOriginal=${capture.offset || ""}`)
      args.push(`-XMP-xmp:CreateDate=${capture.xmp}`)
    }
    if ("make" in patch) args.push(`-EXIF:Make=${patch.make || ""}`)
    if ("model" in patch) args.push(`-EXIF:Model=${patch.model || ""}`)
    if ("latitude" in patch || "longitude" in patch) {
      args.push(...gpsArgs(patch))
    }
    return args
  }

  const verifyValue = (patch, key, actual, expected, message) => {
    if (key in patch && actual !== expected) throw new Error(message)
  }

  const verifyPatch = (patch, embedded) => {
    verifyValue(
      patch,
      "caption",
      embedded.caption,
      captionText(patch.caption),
      "Photo caption XMP verification failed"
    )
    verifyValue(
      patch,
      "important",
      embedded.important,
      Boolean(patch.important),
      "Photo important XMP verification failed"
    )
    verifyValue(
      patch,
      "presentationColor",
      embedded.presentationColor,
      patch.presentationColor || null,
      "Photo presentation color XMP verification failed"
    )
    if ("createdAt" in patch) {
      const capture = captureTime(patch.createdAt)
      verifyValue(
        patch,
        "createdAt",
        embedded.dateTimeOriginal,
        capture.exif,
        "Photo capture time EXIF verification failed"
      )
      verifyValue(
        patch,
        "createdAt",
        embedded.offsetTimeOriginal,
        capture.offset,
        "Photo capture time offset EXIF verification failed"
      )
      verifyValue(
        patch,
        "createdAt",
        embedded.createdAt,
        capture.xmp,
        "Photo capture time XMP verification failed"
      )
    }
    verifyValue(
      patch,
      "make",
      embedded.make,
      patch.make || null,
      "Photo make EXIF verification failed"
    )
    verifyValue(
      patch,
      "model",
      embedded.model,
      patch.model || null,
      "Photo model EXIF verification failed"
    )
    if ("latitude" in patch || "longitude" in patch) {
      const close = (left, right) =>
        left == null && right == null
          ? true
          : Number.isFinite(left) &&
            Number.isFinite(right) &&
            Math.abs(left - right) < 0.000001
      if (
        !close(embedded.latitude, patch.latitude) ||
        !close(embedded.longitude, patch.longitude)
      ) {
        throw new Error("Photo GPS EXIF verification failed")
      }
    }
  }

  async function write(filePath, requested) {
    if (!exiftool)
      throw new Error("ExifTool is required to save photo captions")
    if (!magick)
      throw new Error(
        "ImageMagick 7 (`magick`) is required to save photo captions"
      )
    const patch =
      typeof requested === "object" && requested !== null
        ? { ...requested }
        : { caption: requested }
    if (
      Object.values(patch).some((value) => String(value ?? "").includes("\0"))
    ) {
      throw new Error("Photo caption cannot contain NUL characters")
    }

    const absolutePath = path.resolve(filePath)
    const original = fs.lstatSync(absolutePath)
    if (!original.isFile() || original.isSymbolicLink()) {
      throw new Error("Photo caption target must be a regular file")
    }
    if (original.nlink !== 1) {
      throw new Error(
        "Photo caption target is hard-linked; refusing to replace it"
      )
    }
    fs.accessSync(absolutePath, fs.constants.R_OK)
    fs.accessSync(absolutePath, fs.constants.W_OK)
    fs.accessSync(path.dirname(absolutePath), fs.constants.W_OK)

    const extension = path.extname(absolutePath)
    const basename = path.basename(absolutePath, extension)
    const stagingPath = path.join(
      path.dirname(absolutePath),
      `.${basename}.records-caption-${randomUUID()}${extension}`
    )
    const originalSignatures = await signatures(absolutePath)
    try {
      fs.copyFileSync(absolutePath, stagingPath, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(stagingPath, original.mode & 0o7777)
      const stagedOwner = fs.statSync(stagingPath)
      if (
        Number.isInteger(original.uid) &&
        (stagedOwner.uid !== original.uid || stagedOwner.gid !== original.gid)
      ) {
        fs.chownSync(stagingPath, original.uid, original.gid)
      }
      await run(exiftool, [...writeArgs(patch), stagingPath])

      const embedded = await read(stagingPath)
      verifyPatch(patch, embedded)
      if ("caption" in patch) {
        const caption = captionText(patch.caption)
        const differingMirror = [
          embedded.values.iptc,
          embedded.values.exif
        ].find((value) => value && value !== caption)
        if (differingMirror) {
          throw new Error("Photo caption compatibility-tag verification failed")
        }
      }

      const stagedSignatures = await signatures(stagingPath)
      if (
        stagedSignatures.length !== originalSignatures.length ||
        stagedSignatures.some(
          (value, index) => value !== originalSignatures[index]
        )
      ) {
        throw new Error("Photo pixels changed during metadata write")
      }

      const currentStat = fs.lstatSync(absolutePath)
      if (!sameFile(original, currentStat)) {
        throw new Error("Photo changed while its caption was being saved")
      }
      const handle = fs.openSync(stagingPath, "r")
      try {
        fs.fsyncSync(handle)
      } finally {
        fs.closeSync(handle)
      }
      fs.renameSync(stagingPath, absolutePath)
      try {
        const directoryHandle = fs.openSync(path.dirname(absolutePath), "r")
        try {
          fs.fsyncSync(directoryHandle)
        } finally {
          fs.closeSync(directoryHandle)
        }
      } catch {
        // The verified atomic replacement already succeeded.
      }

      const stat = fs.statSync(absolutePath)
      return {
        caption: embedded.caption,
        embedded,
        byteSize: stat.size,
        checksum: await calculateChecksum(absolutePath),
        mtimeMs: stat.mtimeMs
      }
    } finally {
      fs.rmSync(stagingPath, { force: true })
    }
  }

  return { capabilities, read, write, contentFingerprint }
}
