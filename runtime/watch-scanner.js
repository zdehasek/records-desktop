import fs from "node:fs"
import path from "node:path"
import { fork } from "node:child_process"
import { createHash } from "node:crypto"
import { watch } from "./vendor/chokidar.js"
import {
  projectMessageMetadata,
  readMediaMetadata,
  resolveMediaCreatedAt,
  resolveMediaMimeType,
  UnsupportedMediaError
} from "./media-metadata.js"
import { checksum } from "./runtime-utils.js"
import { runTransaction } from "./src/db/transaction.js"
import { normalizeRelativePath } from "./src/file-roots.js"
import {
  readMediaCompanion,
  companionPath
} from "./src/services/media-companion.js"

const MIME_TYPES = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".webm": "video/webm"
}

const SCAN_WORKER_PATH = new URL("./media-scan-worker.js", import.meta.url)

function validCachedDate(value) {
  const timestamp = String(value || "")
  const date = timestamp.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000-")) {
    return false
  }
  const parsedDate = new Date(`${date}T00:00:00Z`)
  const parsedTimestamp = new Date(timestamp)
  return (
    !Number.isNaN(parsedDate.getTime()) &&
    parsedDate.toISOString().slice(0, 10) === date &&
    !Number.isNaN(parsedTimestamp.getTime())
  )
}

export function filesUnder(root) {
  const files = []
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".records") continue
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(filePath)
      else if (
        entry.isFile() &&
        !entry.name.startsWith("._") &&
        !(
          entry.name.startsWith(".") && entry.name.includes(".records-caption-")
        ) &&
        MIME_TYPES[path.extname(entry.name).toLowerCase()]
      ) {
        let mtimeMs
        try {
          mtimeMs = fs.statSync(filePath).mtimeMs
        } catch (error) {
          if (error.code === "ENOENT") continue
          throw error
        }
        files.push({
          filePath,
          relativePath: normalizeRelativePath(path.relative(root, filePath)),
          mtimeMs
        })
      }
    }
  }
  walk(root)
  return files.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs ||
      right.relativePath.localeCompare(left.relativePath)
  )
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  }
}

async function sourceRevision(root, item, mimeType, stat) {
  const source = {
    rootPath: path.normalize(path.resolve(root.path)),
    relativePath: item.relativePath,
    media: statIdentity(stat)
  }
  if (!mimeType.startsWith("image/")) {
    source.metadataVersion = 2
    const companion = companionPath(item.filePath)
    try {
      const companionStat = fs.statSync(companion)
      source.companion = {
        present: true,
        stat: statIdentity(companionStat),
        contentHash: await checksum(companion)
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
      source.companion = { present: false }
    }
  }
  return createHash("sha256").update(JSON.stringify(source)).digest("hex")
}

function fallbackMetadata(existing) {
  const exifData = existing?.exif_data ? JSON.parse(existing.exif_data) : null
  const createdAt = existing?.created_at
  return {
    createdAt: validCachedDate(createdAt) ? createdAt : null,
    durationSeconds: existing?.duration_seconds ?? null,
    exifData,
    latitude: exifData?.latitude ?? null,
    longitude: exifData?.longitude ?? null,
    mediaType: existing?.mime_type?.split("/")[0] || null
  }
}

function authoritativeImage(extracted, extractionError, existing, stat) {
  return {
    content: extractionError
      ? existing?.content || ""
      : extracted.captionConflict
        ? ""
        : extracted.caption || "",
    createdAt: resolveMediaCreatedAt(extracted, stat.mtime.toISOString()),
    important: extractionError
      ? Boolean(existing?.important)
      : extracted.important === true,
    noteColor: extractionError
      ? existing?.note_color || null
      : extracted.presentationColor || null,
    metadata: extracted,
    extractionError
  }
}

async function authoritative(filePath, mimeType, stat, existing, options) {
  const readMetadata = options.readMediaMetadata || readMediaMetadata
  const image = mimeType.startsWith("image/")
  const companion = image ? null : readMediaCompanion(filePath)
  let extracted
  let extractionError = null
  try {
    extracted = await readMetadata(filePath, {
      captionMetadata: image ? options.captionMetadata : null
    })
  } catch (error) {
    if (!image) throw error
    if (!existing) throw error
    extractionError = error
    extracted = fallbackMetadata(existing)
  }
  if (image)
    return authoritativeImage(extracted, extractionError, existing, stat)
  return {
    content: companion?.content || "",
    createdAt: resolveMediaCreatedAt(
      extracted,
      stat.mtime.toISOString(),
      companion?.metadata.date_override
    ),
    important: companion?.metadata.important === true,
    noteColor: companion?.metadata.note_style?.color || null,
    metadata: extracted,
    extractionError
  }
}

function exifProjection(state) {
  const exif = { ...(state.metadata.exifData || {}) }
  if (state.metadata.latitude != null && state.metadata.longitude != null) {
    exif.latitude = state.metadata.latitude
    exif.longitude = state.metadata.longitude
  }
  return Object.keys(exif).length ? JSON.stringify(exif) : null
}

function buildProjection(
  root,
  item,
  stat,
  state,
  fingerprint,
  revision,
  existing
) {
  const fallbackMime = MIME_TYPES[path.extname(item.filePath).toLowerCase()]
  const mimeType = state.extractionError
    ? existing?.mime_type || fallbackMime
    : resolveMediaMimeType(fallbackMime, state.metadata)
  const metadata = projectMessageMetadata(state.metadata, state)
  return {
    rootName: root.name,
    relativePath: item.relativePath,
    mimeType,
    byteSize: stat.size,
    mtimeMs: state.extractionError ? 0 : stat.mtimeMs,
    content: state.content,
    durationSeconds: metadata.duration_seconds ?? null,
    important: metadata.important ? 1 : 0,
    noteColor: metadata.note_style?.color || null,
    contentFingerprint:
      state.extractionError && existing?.content_fingerprint
        ? existing.content_fingerprint
        : fingerprint,
    exifData: exifProjection(state),
    sourceRevision: state.extractionError ? null : revision,
    createdAt: state.createdAt
  }
}

function insertProjection(db, projection) {
  const inserted = db
    .prepare(
      `INSERT INTO attachments
       (root_name, relative_path, mime_type, byte_size, mtime_ms, content,
         duration_seconds, important, note_color, content_fingerprint, exif_data,
         source_revision, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      projection.rootName,
      projection.relativePath,
      projection.mimeType,
      projection.byteSize,
      projection.mtimeMs,
      projection.content,
      projection.durationSeconds,
      projection.important,
      projection.noteColor,
      projection.contentFingerprint,
      projection.exifData,
      projection.sourceRevision,
      projection.createdAt
    )
  return Number(inserted.lastInsertRowid)
}

function upsertProjection(db, projection) {
  const existing = db
    .prepare(
      "SELECT id FROM attachments WHERE root_name = ? AND relative_path = ?"
    )
    .get(projection.rootName, projection.relativePath)
  if (!existing) {
    return { id: insertProjection(db, projection), imported: 1, reconciled: 0 }
  }
  db.prepare(
    `UPDATE attachments
        SET mime_type = ?, byte_size = ?, mtime_ms = ?, content = ?,
            duration_seconds = ?, important = ?, note_color = ?,
            content_fingerprint = ?, exif_data = ?, source_revision = ?,
            created_at = ?
      WHERE id = ?`
  ).run(
    projection.mimeType,
    projection.byteSize,
    projection.mtimeMs,
    projection.content,
    projection.durationSeconds,
    projection.important,
    projection.noteColor,
    projection.contentFingerprint,
    projection.exifData,
    projection.sourceRevision,
    projection.createdAt,
    existing.id
  )
  return { id: existing.id, imported: 0, reconciled: 1 }
}

function attachmentSnapshot(row, root = null) {
  const filePath = root?.path
    ? path.join(root.path, ...row.relative_path.split("/"))
    : null
  return {
    ...row,
    file_path: filePath,
    filePath,
    relativePath: row.relative_path
  }
}

export function createWatchScanner(db, events, options = {}) {
  let timer = null
  let debounceTimer = null
  let scanPromise = null
  let operationTail = Promise.resolve()
  let activeWorker = null
  let rescanRequested = false
  let started = false
  let stopping = false
  let currentImportProgress = null
  const watchers = new Map()
  const knownRoots = new Map()

  function publishImportProgress(progress) {
    currentImportProgress = progress.complete ? null : progress
    events.emit("photos-import-progress", progress)
  }

  function completeImportProgress(error = null) {
    if (!currentImportProgress) return
    publishImportProgress({
      ...currentImportProgress,
      done: error ? currentImportProgress.done : currentImportProgress.total,
      file: null,
      complete: true,
      ...(error && { error: "Media indexing failed" })
    })
  }

  function notifyAttachmentChanged(snapshot) {
    try {
      options.onAttachmentChanged?.(snapshot)
    } catch (error) {
      console.warn(`[media-cache] ${snapshot.relative_path}: ${error.message}`)
    }
  }

  function requestScan() {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (scanPromise) {
        rescanRequested = true
        return
      }
      scan().catch(console.error)
    }, 250)
    debounceTimer.unref?.()
  }

  function syncWatchers() {
    const roots = options.config
      .mediaRoots({ enabledOnly: true })
      .filter((root) => root.enabled !== false)
      .filter(
        (root) =>
          fs.existsSync(root.path) && fs.statSync(root.path).isDirectory()
      )
    const active = new Set(roots.map((root) => `${root.name}:${root.path}`))
    for (const [key, watcher] of watchers) {
      if (active.has(key)) continue
      watchers.delete(key)
      watcher.close().catch(console.error)
    }
    for (const root of roots) {
      knownRoots.set(root.name, root)
      const key = `${root.name}:${root.path}`
      if (watchers.has(key)) continue
      const watcher = (options.watch || watch)(root.path, {
        awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
        followSymlinks: false,
        ignoreInitial: true,
        ignored: /(^|[/\\])\.records([/\\]|$)/
      })
      watcher.on("all", requestScan)
      watcher.on("error", (error) =>
        console.warn(`[media-watch] ${root.path}: ${error.message}`)
      )
      watchers.set(key, watcher)
    }
  }

  function rootProgress(root, files, existing) {
    const progress = existing || {
      done: 0,
      total: files.length,
      indexed: 0,
      skipped: 0,
      errors: 0
    }
    progress.indexed ??= 0
    progress.skipped ??= 0
    progress.errors ??= 0
    progress.rootName = root.name
    progress.rootPath = root.path
    progress.rootDone = 0
    progress.rootTotal = files.length
    return progress
  }

  function cachedProjection(root, item) {
    return db
      .prepare(
        "SELECT * FROM attachments WHERE root_name = ? AND relative_path = ?"
      )
      .get(root.name, item.relativePath)
  }

  function projectionIsCurrent(cached, revision, stageOptions) {
    return Boolean(
      stageOptions.incremental &&
      cached?.source_revision !== null &&
      cached?.source_revision === revision &&
      validCachedDate(cached.created_at)
    )
  }

  async function mediaFingerprint(filePath, mimeType, digest) {
    if (
      !mimeType.startsWith("image/") ||
      !options.captionMetadata?.contentFingerprint
    ) {
      return digest
    }
    return (
      (await options.captionMetadata
        .contentFingerprint(filePath)
        .catch(() => null)) || digest
    )
  }

  async function stageItem(root, item, cached, stageOptions, staged) {
    const stat = fs.lstatSync(item.filePath)
    const mimeType = MIME_TYPES[path.extname(item.filePath).toLowerCase()]
    const revision = await sourceRevision(root, item, mimeType, stat)
    if (projectionIsCurrent(cached, revision, stageOptions)) {
      staged.seen.add(item.relativePath)
      staged.progress.indexed += 1
      return false
    }

    const state = await authoritative(
      item.filePath,
      mimeType,
      stat,
      stageOptions.replace ? null : cached,
      options
    )
    staged.seen.add(item.relativePath)
    if (state.extractionError) {
      console.warn(
        `[media-scan] ${item.filePath}: ${state.extractionError.message}; using filesystem metadata`
      )
    }
    const digest = await checksum(item.filePath)
    const fingerprint = await mediaFingerprint(item.filePath, mimeType, digest)
    const projection = buildProjection(
      root,
      item,
      stat,
      state,
      fingerprint,
      revision,
      stageOptions.replace ? null : cached
    )
    if (stageOptions.onProjection) {
      await stageOptions.onProjection(projection)
    } else {
      staged.projections.push(projection)
    }
    staged.progress.indexed += 1
    return true
  }

  function recordStageFailure(item, cached, error, staged) {
    const conclusivelyUnsupported =
      error instanceof UnsupportedMediaError && error.retryable === false
    if (cached && !conclusivelyUnsupported) {
      staged.seen.add(item.relativePath)
      staged.progress.indexed += 1
    } else {
      staged.progress.skipped += 1
    }
    if (!conclusivelyUnsupported) staged.progress.errors += 1
    staged.diagnostics.push({
      filePath: item.filePath,
      error: error.message,
      fatal: !conclusivelyUnsupported
    })
    console.warn(`[media-scan] ${item.filePath}: ${error.message}`)
  }

  function publishStagedFile(progress, item) {
    publishImportProgress({
      ...progress,
      file: item ? path.basename(item.filePath) : null,
      complete: false
    })
  }

  async function stageRoot(root, stageOptions = {}) {
    const files = stageOptions.files || filesUnder(root.path)
    const ownsProgress = !stageOptions.progress
    const staged = {
      root,
      seen: new Set(),
      projections: [],
      diagnostics: [],
      progress: rootProgress(root, files, stageOptions.progress)
    }
    let processed = 0
    if (ownsProgress) publishStagedFile(staged.progress)
    for (const item of files) {
      const cached = cachedProjection(root, item)
      publishStagedFile(staged.progress, item)
      try {
        const didProcess = await stageItem(
          root,
          item,
          cached,
          stageOptions,
          staged
        )
        if (didProcess) processed += 1
        if (didProcess && options.batchPauseMs && processed % 5 === 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.batchPauseMs)
          )
        }
      } catch (error) {
        recordStageFailure(item, cached, error, staged)
      }
      staged.progress.done += 1
      staged.progress.rootDone += 1
      publishStagedFile(staged.progress, item)
    }
    if (ownsProgress) completeImportProgress()
    const { progress: _progress, ...result } = staged
    return result
  }

  function commitRoot(staged, commitOptions = {}) {
    const changed = []
    const removed = []
    const removedRoot = commitOptions.replace
      ? knownRoots.get(staged.root.name) || staged.root
      : staged.root
    const totals = runTransaction(db, () => {
      const result = { imported: 0, reconciled: 0, removed: 0 }
      const current = db
        .prepare("SELECT * FROM attachments WHERE root_name = ?")
        .all(staged.root.name)
      const stale = commitOptions.replace
        ? current
        : current.filter((row) => !staged.seen.has(row.relative_path))
      const remove = db.prepare("DELETE FROM attachments WHERE id = ?")
      for (const row of stale) {
        removed.push(attachmentSnapshot(row, removedRoot))
        remove.run(row.id)
      }
      for (const projection of staged.projections) {
        const applied = commitOptions.replace
          ? {
              id: insertProjection(db, projection),
              imported: 1,
              reconciled: 0
            }
          : upsertProjection(db, projection)
        result.imported += applied.imported
        result.reconciled += applied.reconciled
        if (applied.reconciled) {
          const row = db
            .prepare("SELECT * FROM attachments WHERE id = ?")
            .get(applied.id)
          changed.push(attachmentSnapshot(row, staged.root))
        }
      }
      result.removed = stale.length
      return result
    })
    if (commitOptions.notify !== false) {
      for (const snapshot of [...removed, ...changed]) {
        notifyAttachmentChanged(snapshot)
      }
    }
    if (
      commitOptions.emit !== false &&
      (totals.imported || totals.reconciled || totals.removed)
    ) {
      events.emit("data-changed", { method: "media:scan", ...totals })
    }
    return { ...totals, removedAttachments: removed }
  }

  async function scanRoot(root, scanOptions = {}) {
    const totals = { imported: 0, reconciled: 0, removed: 0 }
    const staged = await stageRoot(root, {
      incremental: true,
      ...scanOptions,
      onProjection: (projection) => {
        const applied = runTransaction(db, () =>
          upsertProjection(db, projection)
        )
        totals.imported += applied.imported
        totals.reconciled += applied.reconciled
        if (applied.reconciled) {
          const row = db
            .prepare("SELECT * FROM attachments WHERE id = ?")
            .get(applied.id)
          notifyAttachmentChanged(attachmentSnapshot(row, root))
        }
      }
    })
    const cleanup = commitRoot(staged, { emit: false })
    totals.removed = cleanup.removed
    return { ...totals, removedAttachments: cleanup.removedAttachments }
  }

  function replaceRoot(rootOrStage, replaceOptions = {}) {
    return enqueueOperation(async () => {
      if (options.databasePath && !rootOrStage.projections) {
        return runWorker({
          operation: "replace-root",
          roots: [rootOrStage],
          root: rootOrStage,
          options: replaceOptions
        })
      }
      if (rootOrStage.projections) {
        return commitRoot(rootOrStage, { ...replaceOptions, replace: true })
      }
      const files = filesUnder(rootOrStage.path)
      const progress = {
        done: 0,
        total: files.length,
        indexed: 0,
        skipped: 0,
        errors: 0,
        rootName: null,
        rootPath: null,
        rootDone: 0,
        rootTotal: 0
      }
      publishImportProgress({ ...progress, file: null, complete: false })
      const staged = await stageRoot(rootOrStage, {
        replace: true,
        files,
        progress
      })
      const result = commitRoot(staged, {
        ...replaceOptions,
        replace: true
      })
      completeImportProgress()
      return result
    }).catch((error) => {
      completeImportProgress(stopping ? null : error)
      throw error
    })
  }

  function pruneRoot(rootOrName, pruneOptions = {}) {
    const name = typeof rootOrName === "string" ? rootOrName : rootOrName.name
    const root =
      typeof rootOrName === "string"
        ? knownRoots.get(name) || { name }
        : rootOrName
    const rows = db
      .prepare("SELECT * FROM attachments WHERE root_name = ?")
      .all(name)
    const snapshots = rows.map((row) => attachmentSnapshot(row, root))
    runTransaction(db, () => {
      db.prepare("DELETE FROM attachments WHERE root_name = ?").run(name)
    })
    if (pruneOptions.notify !== false) {
      for (const snapshot of snapshots) notifyAttachmentChanged(snapshot)
    }
    if (pruneOptions.emit !== false && snapshots.length) {
      events.emit("data-changed", {
        method: "media:scan",
        imported: 0,
        reconciled: 0,
        removed: snapshots.length
      })
    }
    return snapshots
  }

  function pruneRootWhenIdle(rootOrName, pruneOptions = {}) {
    return enqueueOperation(() => pruneRoot(rootOrName, pruneOptions))
  }

  async function runScan() {
    const totals = { imported: 0, reconciled: 0, removed: 0 }
    const configuredRoots = options.config.mediaRoots()
    const enabledRoots = configuredRoots.filter(
      (root) => root.enabled !== false
    )
    const scannedRoots = enabledRoots
      .filter(
        (root) =>
          fs.existsSync(root.path) && fs.statSync(root.path).isDirectory()
      )
      .map((root) => ({ root, files: filesUnder(root.path) }))
    const progress = {
      done: 0,
      total: scannedRoots.reduce(
        (total, entry) => total + entry.files.length,
        0
      ),
      indexed: 0,
      skipped: 0,
      errors: 0,
      rootName: null,
      rootPath: null,
      rootDone: 0,
      rootTotal: 0
    }
    publishImportProgress({ ...progress, file: null, complete: false })
    for (const root of configuredRoots) knownRoots.set(root.name, root)
    if (started) syncWatchers()
    for (const { root, files } of scannedRoots) {
      const result = await scanRoot(root, { files, progress })
      totals.imported += result.imported
      totals.reconciled += result.reconciled
      totals.removed += result.removed
    }
    const enabledNames = new Set(enabledRoots.map((root) => root.name))
    const indexedNames = db
      .prepare("SELECT DISTINCT root_name FROM attachments")
      .all()
      .map((row) => row.root_name)
    for (const name of indexedNames) {
      if (enabledNames.has(name)) continue
      totals.removed += pruneRoot(name, { emit: false }).length
    }
    if (totals.imported || totals.reconciled || totals.removed) {
      events.emit("data-changed", { method: "media:scan", ...totals })
    }
    completeImportProgress()
    return totals.removed
      ? totals
      : { imported: totals.imported, reconciled: totals.reconciled }
  }

  function runWorker(request) {
    return new Promise((resolve, reject) => {
      const child = fork(options.workerPath || SCAN_WORKER_PATH, [], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      })
      activeWorker = child
      const output = { stdout: [], stderr: [] }
      let result
      let settled = false

      const remember = (stream, chunk) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          output[stream].push(line)
          if (output[stream].length > 200) output[stream].shift()
        }
      }
      child.stdout.on("data", (chunk) => remember("stdout", chunk))
      child.stderr.on("data", (chunk) => remember("stderr", chunk))
      child.on("message", (message) => {
        if (message.type === "event") {
          if (message.channel === "photos-import-progress") {
            publishImportProgress(message.data)
          } else {
            events.emit(message.channel, message.data)
          }
        } else if (message.type === "attachment-changed") {
          notifyAttachmentChanged(message.attachment)
        } else if (message.type === "result") {
          result = message.result
        }
      })
      child.once("error", (error) => {
        if (settled) return
        settled = true
        if (activeWorker === child) activeWorker = null
        completeImportProgress(stopping ? null : error)
        reject(error)
      })
      child.once("exit", (code, signal) => {
        if (activeWorker === child) activeWorker = null
        if (settled) return
        settled = true
        if (result !== undefined && code === 0) {
          completeImportProgress()
          resolve(result)
          return
        }
        const details = [...output.stderr, ...output.stdout]
        const suffix = details.length ? `\n${details.join("\n")}` : ""
        const error = new Error(
          `Media scan worker exited with ${signal || `code ${code}`}${suffix}`
        )
        completeImportProgress(stopping ? null : error)
        reject(error)
      })
      child.send({
        ...request,
        databasePath: options.databasePath
      })
    })
  }

  function enqueueOperation(operation) {
    const queued = operationTail.then(() => {
      if (stopping) throw new Error("Media scanner is stopping")
      return operation()
    })
    operationTail = queued.catch(() => {})
    return queued
  }

  function waitForWorkerExit(worker, timeoutMs) {
    if (worker.exitCode !== null || worker.signalCode !== null) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        worker.off("exit", onExit)
        resolve(false)
      }, timeoutMs)
      worker.once("exit", onExit)
    })
  }

  async function terminateWorker(worker, graceMs) {
    worker.kill("SIGTERM")
    if (await waitForWorkerExit(worker, graceMs)) return true
    worker.kill("SIGKILL")
    return waitForWorkerExit(worker, graceMs)
  }

  function scan() {
    if (scanPromise) return scanPromise
    const operation = enqueueOperation(() =>
      options.databasePath
        ? runWorker({ operation: "scan", roots: options.config.mediaRoots() })
        : runScan()
    )
    scanPromise = operation
      .catch((error) => {
        completeImportProgress(stopping ? null : error)
        throw error
      })
      .finally(() => {
        scanPromise = null
        if (rescanRequested && started && !stopping) {
          rescanRequested = false
          queueMicrotask(() => scan().catch(console.error))
        }
      })
    return scanPromise
  }

  async function refreshRoots() {
    await scanPromise
    if (started) syncWatchers()
    return scan()
  }

  async function start() {
    started = true
    stopping = false
    syncWatchers()
    await scan()
    if (!started) return
    timer = setInterval(() => scan().catch(console.error), 5 * 60 * 1000)
    timer.unref()
  }

  async function stop(stopOptions = {}) {
    started = false
    stopping = true
    if (timer) clearInterval(timer)
    clearTimeout(debounceTimer)
    for (const watcher of watchers.values())
      watcher.close().catch(console.error)
    watchers.clear()
    const worker = activeWorker
    const workerExited = worker
      ? await terminateWorker(
          worker,
          stopOptions.workerStopGraceMs ?? options.workerStopGraceMs ?? 2_000
        )
      : true
    if (workerExited) {
      try {
        await scanPromise
      } catch (error) {
        if (!stopping) throw error
      }
      await operationTail
    }
  }

  function forceStopWorker() {
    activeWorker?.kill("SIGKILL")
  }

  return {
    commitRoot,
    pruneRoot,
    pruneRootWhenIdle,
    refreshRoots,
    requestScan,
    replaceRoot,
    scan,
    stageRoot,
    start,
    stop,
    forceStopWorker,
    syncWatchers
  }
}
