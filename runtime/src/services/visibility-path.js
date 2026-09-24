import fs from "node:fs"
import path from "node:path"
import { normalizeRelativePath, resolveRootPath } from "../file-roots.js"
import { companionPath } from "./media-companion.js"

const RESERVED_CATEGORIES = new Set([".records", ".hidden", ".nsfw"])

export function validateCategory(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value === "." ||
    value === ".." ||
    RESERVED_CATEGORIES.has(value)
  ) {
    throw new Error("category must be a safe single path segment")
  }
  return value.normalize("NFC")
}

export function parseVisibilityPath(value) {
  const relativePath = normalizeRelativePath(value)
  const parts = relativePath.split("/")
  if ((parts[0] === ".nsfw" || parts[0] === ".hidden") && parts.length >= 3) {
    const category = validateCategory(parts[1])
    const originalPath = normalizeRelativePath(parts.slice(2).join("/"))
    return {
      category,
      originalPath,
      relativePath,
      visibility: parts[0] === ".hidden" ? `.${category}` : category
    }
  }
  return {
    category: "general",
    originalPath: relativePath,
    relativePath,
    visibility: "visible"
  }
}

export function visibilityRelativePath(
  originalPath,
  visibility,
  category = "general"
) {
  const normalized = normalizeRelativePath(originalPath)
  if (visibility === "visible") return normalized
  const safeCategory = validateCategory(category)
  if (visibility === "nsfw") return `.nsfw/${safeCategory}/${normalized}`
  if (visibility === "hidden") return `.hidden/${safeCategory}/${normalized}`
  throw new Error(`invalid visibility: ${visibility}`)
}

export function moveVisibility({
  root,
  relativePath,
  visibility,
  category,
  duplicateStore
}) {
  const parsed = parseVisibilityPath(relativePath)
  const targetRelativePath = visibilityRelativePath(
    parsed.originalPath,
    visibility,
    category || parsed.category
  )
  if (targetRelativePath === parsed.relativePath) return targetRelativePath
  const source = resolveRootPath(root, parsed.relativePath)
  const target = resolveRootPath(root, targetRelativePath)
  const sourceStat = fs.lstatSync(source)
  if (sourceStat.isSymbolicLink())
    throw new Error("symlink items are view-only")
  if (!sourceStat.isFile()) throw new Error("visibility source must be a file")
  if (fs.existsSync(target))
    throw new Error(`visibility destination exists: ${target}`)
  const sourceCompanion = companionPath(source)
  const targetCompanion = companionPath(target)
  if (fs.existsSync(sourceCompanion) && fs.existsSync(targetCompanion)) {
    throw new Error(`visibility destination exists: ${targetCompanion}`)
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.renameSync(source, target)
  let companionMoved = false
  try {
    if (fs.existsSync(sourceCompanion)) {
      fs.renameSync(sourceCompanion, targetCompanion)
      companionMoved = true
    }
    duplicateStore?.rewriteReferences(
      { root: root.name, path: parsed.relativePath },
      { root: root.name, path: targetRelativePath }
    )
  } catch (error) {
    const rollbackErrors = []
    if (companionMoved) {
      try {
        fs.renameSync(targetCompanion, sourceCompanion)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    try {
      fs.renameSync(target, source)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (rollbackErrors.length) {
      error.rollbackErrors = [
        ...(error.rollbackErrors || []),
        ...rollbackErrors
      ]
    }
    throw error
  }
  return targetRelativePath
}
