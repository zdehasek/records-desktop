import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const CACHE_KEY_VERSION = 1

function hash(parts) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

function sourcePath(source) {
  const filePath = source?.filePath || source?.file_path
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("Media cache source requires a file path")
  }
  return filePath
}

function normalizedRelativePath(source, filePath) {
  const relativePath = source?.relativePath || source?.relative_path
  if (typeof relativePath !== "string" || !relativePath) {
    return path.basename(filePath)
  }
  const parts = relativePath
    .split(/[\\/]+/)
    .filter((part) => part && part !== ".")
  if (parts.includes("..")) {
    throw new Error("Media cache relative path must not traverse")
  }
  return parts.join("/")
}

export function mediaSourceId(source) {
  const filePath = sourcePath(source)
  const physicalPath = fs.realpathSync(filePath)
  const relativePath = normalizedRelativePath(source, filePath)
  let rootPath = path.resolve(filePath)
  for (const _part of relativePath.split("/")) rootPath = path.dirname(rootPath)
  const physicalRoot = fs.realpathSync(rootPath)
  return hash([
    CACHE_KEY_VERSION,
    "source",
    physicalRoot,
    physicalPath,
    relativePath
  ])
}

/**
 * Build a derivative-cache identity from the current physical file and stat.
 * Numeric projection IDs are deliberately excluded.
 */
export function mediaCacheKey(source) {
  const filePath = sourcePath(source)
  const physicalPath = fs.realpathSync(filePath)
  const stat = fs.statSync(physicalPath)
  const sourceId = mediaSourceId(source)
  const sourceRevision = hash([
    CACHE_KEY_VERSION,
    "revision",
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs
  ])

  return { sourceId, sourceRevision }
}
