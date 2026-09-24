import crypto from "node:crypto"
import fs from "node:fs"

export function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

export function sanitizeExif(value, depth = 0) {
  if (depth > 10) return undefined
  if (value == null) return value
  if (["string", "number", "boolean"].includes(typeof value)) return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value)) return undefined
  if (value instanceof Uint8Array || value instanceof ArrayBuffer)
    return undefined
  if (ArrayBuffer.isView(value)) return undefined
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeExif(item, depth + 1))
      .filter((item) => item !== undefined)
  }
  if (typeof value !== "object") return undefined

  const clean = {}
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeExif(item, depth + 1)
    if (sanitized !== undefined) clean[key] = sanitized
  }
  return clean
}

function dmsToDecimal(dms, reference) {
  if (!Array.isArray(dms) || dms.length < 2) return null
  const degrees = Number(dms[0])
  const minutes = Number(dms[1])
  const seconds = Number(dms[2]) || 0
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null
  const sign = reference === "S" || reference === "W" ? -1 : 1
  return sign * (degrees + minutes / 60 + seconds / 3600)
}

export function extractGps(parsed) {
  if (!parsed) return { latitude: null, longitude: null }
  let latitude = typeof parsed.latitude === "number" ? parsed.latitude : null
  let longitude = typeof parsed.longitude === "number" ? parsed.longitude : null
  if (latitude == null || longitude == null) {
    latitude = dmsToDecimal(parsed.GPSLatitude, parsed.GPSLatitudeRef)
    longitude = dmsToDecimal(parsed.GPSLongitude, parsed.GPSLongitudeRef)
  }
  return { latitude, longitude }
}

export function formatGps(latitude, longitude) {
  if (latitude == null || longitude == null) return ""
  const latitudeDirection = latitude >= 0 ? "N" : "S"
  const longitudeDirection = longitude >= 0 ? "E" : "W"
  return `${Math.abs(latitude).toFixed(4)}${latitudeDirection}, ${Math.abs(longitude).toFixed(4)}${longitudeDirection}`
}
