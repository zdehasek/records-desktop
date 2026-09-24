import fs from "node:fs"
import path from "node:path"

const ROOT_NAME = /^[a-z0-9][a-z0-9_-]*$/

export function validateRootName(value) {
  if (typeof value !== "string" || !ROOT_NAME.test(value)) {
    throw new Error(`invalid root name: ${value}`)
  }
  return value
}

export function normalizeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error("invalid relative path")
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("relative path must not be absolute")
  }
  const parts = value.split(/[\\/]+/)
  if (parts.includes("..")) throw new Error("relative path must not traverse")
  const normalized = parts.filter((part) => part && part !== ".").join("/")
  if (!normalized) throw new Error("relative path must name a file")
  return normalized
}

export function canonicalFileReference(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid file reference")
  }
  return {
    root: validateRootName(value.root),
    path: normalizeRelativePath(value.path)
  }
}

export function fileIdentity(value) {
  const reference = canonicalFileReference(value)
  return `${reference.root}:${reference.path}`
}

export function normalizeRoot(value, label = "root") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid ${label}`)
  }
  if (typeof value.path !== "string" || !path.isAbsolute(value.path)) {
    throw new Error(`${label} path must be absolute`)
  }
  return {
    ...value,
    name: validateRootName(value.name),
    path: path.resolve(value.path),
    enabled: value.enabled !== false
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right)
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
}

export function comparablePath(rootPath) {
  const absolute = path.resolve(rootPath)
  let existing = absolute
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return absolute
    existing = parent
  }
  return path.join(fs.realpathSync(existing), path.relative(existing, absolute))
}

export function validateRoots(values, label = "root") {
  if (!Array.isArray(values)) throw new Error(`${label}s must be an array`)
  const roots = values.map((value) => normalizeRoot(value, label))
  if (new Set(roots.map((root) => root.name)).size !== roots.length) {
    throw new Error(`duplicate ${label} name`)
  }
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      const left = comparablePath(roots[index].path)
      const right = comparablePath(roots[other].path)
      if (pathsOverlap(left, right) || pathsOverlap(right, left)) {
        throw new Error(`duplicate or overlapping ${label} path`)
      }
    }
  }
  return roots
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate)
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

export function resolveRootPath(root, relativePath) {
  const normalizedRoot = normalizeRoot(root)
  const normalizedRelative = normalizeRelativePath(relativePath)
  const candidate = path.resolve(
    normalizedRoot.path,
    ...normalizedRelative.split("/")
  )
  if (!isWithin(normalizedRoot.path, candidate)) {
    throw new Error("unsafe root resolution")
  }

  if (fs.existsSync(normalizedRoot.path)) {
    const realRoot = fs.realpathSync(normalizedRoot.path)
    let existing = candidate
    while (!fs.existsSync(existing) && existing !== normalizedRoot.path) {
      existing = path.dirname(existing)
    }
    if (!isWithin(realRoot, fs.realpathSync(existing))) {
      throw new Error("unsafe root resolution")
    }
  }
  return candidate
}
