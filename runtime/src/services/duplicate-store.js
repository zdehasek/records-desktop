import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { parseDocument, stringify } from "../../vendor/yaml.js"
import { canonicalFileReference } from "../file-roots.js"
import { ensurePrivateDirectory, recordsDataDirectory } from "../paths.js"

const FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function validateFingerprint(value) {
  if (typeof value !== "string" || !FINGERPRINT.test(value)) {
    throw new Error("invalid duplicate fingerprint")
  }
  return value
}

export function defaultDuplicatesDirectory() {
  return path.join(recordsDataDirectory(), "duplicates")
}

function normalizeRecord(value, fingerprint) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid duplicate record")
  }
  return {
    ...value,
    version: 1,
    fingerprint,
    canonical: canonicalFileReference(value.canonical),
    duplicates: (value.duplicates || []).map(canonicalFileReference)
  }
}

function appendRollbackError(error, rollbackError) {
  error.rollbackErrors = [...(error.rollbackErrors || []), rollbackError]
}

function atomicWrite(filePath, contents, mode = 0o600) {
  const directory = ensurePrivateDirectory(path.dirname(filePath))
  const temporary = path.join(
    directory,
    `.duplicate-${process.pid}-${randomUUID()}.tmp`
  )
  let handle = null
  try {
    handle = fs.openSync(temporary, "wx", 0o600)
    const source = Buffer.isBuffer(contents)
      ? contents
      : contents.endsWith("\n")
        ? contents
        : `${contents}\n`
    fs.writeFileSync(handle, source)
    fs.fchmodSync(handle, mode)
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = null
    fs.renameSync(temporary, filePath)
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle)
      } catch (cleanupError) {
        appendRollbackError(error, cleanupError)
      }
    }
    try {
      fs.rmSync(temporary, { force: true })
    } catch (cleanupError) {
      appendRollbackError(error, cleanupError)
    }
    throw error
  }
}

function referencesMatch(left, right) {
  return left.root === right.root && left.path === right.path
}

function updateReferenceNode(node, reference) {
  for (const key of ["root", "path"]) {
    const scalar = node.get(key, true)
    if (scalar && typeof scalar === "object" && "value" in scalar) {
      scalar.value = reference[key]
    } else {
      node.set(key, reference[key])
    }
  }
  return node
}

function referenceFromNode(node) {
  return canonicalFileReference({
    root: node.get("root"),
    path: node.get("path")
  })
}

function updateRecordNodes(document, record) {
  let duplicates = document.get("duplicates", true)
  if (!duplicates?.items) {
    duplicates = document.createNode([])
    document.set("duplicates", duplicates)
  }

  const available = [
    {
      node: document.get("canonical", true),
      reference: referenceFromNode(document.get("canonical", true))
    },
    ...duplicates.items.map((node) => ({
      node,
      reference: referenceFromNode(node)
    }))
  ]

  const takeNode = (reference) => {
    const index = available.findIndex((entry) =>
      referencesMatch(entry.reference, reference)
    )
    if (index === -1) return document.createNode(reference)
    const [{ node }] = available.splice(index, 1)
    return updateReferenceNode(node, reference)
  }

  const canonical = takeNode(record.canonical)
  const duplicateItems = record.duplicates.map(takeNode)
  document.set("canonical", canonical)
  duplicates.items = duplicateItems
}

export class DuplicateStore {
  constructor(directory = defaultDuplicatesDirectory()) {
    this.directory = path.resolve(directory)
  }

  filePath(fingerprint) {
    return path.join(this.directory, `${validateFingerprint(fingerprint)}.yaml`)
  }

  read(fingerprint) {
    const filePath = this.filePath(fingerprint)
    if (!fs.existsSync(filePath)) return null
    const document = parseDocument(fs.readFileSync(filePath, "utf8"))
    if (document.errors.length) throw document.errors[0]
    return normalizeRecord(document.toJS(), fingerprint)
  }

  write(fingerprint, value) {
    const filePath = this.filePath(fingerprint)
    let document
    if (fs.existsSync(filePath)) {
      document = parseDocument(fs.readFileSync(filePath, "utf8"))
      if (document.errors.length) throw document.errors[0]
    } else {
      document = parseDocument(stringify(value))
    }
    const normalized = normalizeRecord(value, fingerprint)
    document.set("version", 1)
    document.set("fingerprint", fingerprint)
    updateRecordNodes(document, normalized)
    atomicWrite(filePath, document.toString())
    return normalized
  }

  rewriteReferences(fromValue, toValue) {
    if (!fs.existsSync(this.directory)) return 0
    const from = canonicalFileReference(fromValue)
    const to = canonicalFileReference(toValue)
    const changes = []

    for (const name of fs
      .readdirSync(this.directory)
      .filter((entry) => entry.endsWith(".yaml"))
      .sort()) {
      const fingerprint = validateFingerprint(name.slice(0, -5))
      const filePath = this.filePath(fingerprint)
      const source = fs.readFileSync(filePath)
      const mode = fs.statSync(filePath).mode & 0o7777
      const document = parseDocument(source.toString("utf8"))
      if (document.errors.length) throw document.errors[0]
      const record = normalizeRecord(document.toJS(), fingerprint)
      let changed = false
      if (referencesMatch(record.canonical, from)) {
        document.setIn(["canonical", "root"], to.root)
        document.setIn(["canonical", "path"], to.path)
        changed = true
      }
      record.duplicates.forEach((reference, index) => {
        if (!referencesMatch(reference, from)) return
        document.setIn(["duplicates", index, "root"], to.root)
        document.setIn(["duplicates", index, "path"], to.path)
        changed = true
      })
      if (!changed) continue
      changes.push({ document, filePath, mode, source })
    }

    const written = []
    try {
      for (const change of changes) {
        atomicWrite(change.filePath, change.document.toString(), change.mode)
        written.push(change)
      }
    } catch (error) {
      for (const change of written.reverse()) {
        try {
          atomicWrite(change.filePath, change.source, change.mode)
        } catch (rollbackError) {
          appendRollbackError(error, rollbackError)
        }
      }
      throw error
    }
    return changes.length
  }

  delete(fingerprint) {
    const filePath = this.filePath(fingerprint)
    try {
      fs.unlinkSync(filePath)
      return true
    } catch (error) {
      if (error.code === "ENOENT") return false
      throw error
    }
  }

  list() {
    if (!fs.existsSync(this.directory)) return []
    return fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith(".yaml"))
      .sort()
      .map((name) => this.read(name.slice(0, -5)))
  }
}

export function openDuplicateStore(directory = defaultDuplicatesDirectory()) {
  return new DuplicateStore(directory)
}
