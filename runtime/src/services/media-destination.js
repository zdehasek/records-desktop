import { randomBytes } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function validateWritableDirectory(candidate, label) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`)
  }

  let candidateStat
  try {
    candidateStat = fs.lstatSync(candidate)
  } catch {
    throw new Error(`${label} must exist and be writable`)
  }
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary directory`)
  }

  let root
  try {
    root = fs.realpathSync(candidate)
  } catch {
    throw new Error(`${label} must exist and be writable`)
  }

  if (root === path.parse(root).root) {
    throw new Error(`${label} cannot be the filesystem root`)
  }
  let stat
  try {
    stat = fs.statSync(root)
  } catch {
    throw new Error(`${label} must exist and be writable`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory`)
  }
  try {
    fs.accessSync(root, fs.constants.W_OK)
  } catch {
    throw new Error(`${label} must exist and be writable`)
  }
  return root
}

export function prepareImportDestination(candidate) {
  const root = validateWritableDirectory(candidate, "Default media folder")
  const created = []
  try {
    const records = path.join(root, "records")
    if (!fs.existsSync(records)) {
      fs.mkdirSync(records, { mode: 0o700 })
      created.push(records)
    }
    const childStat = fs.lstatSync(records)
    if (!childStat.isDirectory() || childStat.isSymbolicLink()) {
      throw new Error("records folder must be an ordinary directory")
    }
    try {
      fs.accessSync(records, fs.constants.W_OK)
    } catch {
      throw new Error("records folder must be writable")
    }
    return { root, records, created }
  } catch (error) {
    for (const child of created.reverse()) fs.rmdirSync(child)
    throw error
  }
}

export function prepareDatedImportDirectory(root, date) {
  const prepared = prepareImportDestination(root)
  let directory = prepared.records
  try {
    for (const part of date.split("-")) {
      directory = path.join(directory, part)
      if (!fs.existsSync(directory)) {
        fs.mkdirSync(directory, { mode: 0o700 })
        prepared.created.push(directory)
      }
      const stat = fs.lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("import date path must contain ordinary directories")
      }
    }
    return { ...prepared, directory }
  } catch (error) {
    cleanupImportDirectories(prepared.created)
    throw error
  }
}

export function prepareImportPath(root, date, sourcePath) {
  const prepared = prepareDatedImportDirectory(root, date)
  const extension = path.extname(sourcePath).toLowerCase()
  const baseName = path
    .basename(sourcePath, extension)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return {
    ...prepared,
    filePath: path.join(
      prepared.directory,
      `${baseName || "media"}-${randomBytes(4).toString("hex")}${extension}`
    )
  }
}

export function cleanupImportDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    try {
      fs.rmdirSync(directory)
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error
    }
  }
}

function isWithinRoot(filePath, root) {
  const relative = path.relative(root, filePath)
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function deleteOwnedMedia(attachment, defaultRoot) {
  if (!attachment?.file_path) return false
  const recordedRoot = attachment.root_path || defaultRoot
  if (!path.isAbsolute(recordedRoot)) return false
  const root = path.resolve(recordedRoot)
  if (root === path.parse(root).root) return false
  const filePath = path.resolve(attachment.file_path)
  if (!isWithinRoot(filePath, root)) return false

  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return false

    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false
    const realRoot = fs.realpathSync(root)
    const realFile = fs.realpathSync(filePath)
    if (!isWithinRoot(realFile, realRoot)) return false

    fs.unlinkSync(filePath)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}
