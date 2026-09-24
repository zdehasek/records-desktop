import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { openDatabase } from "../../runtime/database.js"
import { runTransaction } from "../../runtime/src/db/transaction.js"
import { updateMediaAttachment } from "../../runtime/src/services/media-update.js"
import { createWatchScanner, filesUnder } from "../../runtime/watch-scanner.js"

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await delay(10)
  }
  throw new Error("Timed out waiting for condition")
}

test("worker-backed scans keep the parent event loop responsive", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-worker-"))
  const databasePath = path.join(directory, "cache.sqlite3")
  const workerPath = path.join(directory, "scan-worker.mjs")
  fs.writeFileSync(
    workerPath,
    `process.once("message", () => {
      process.send({ type: "event", channel: "test-worker-started", data: true })
      setTimeout(() => {
        const until = Date.now() + 300
        while (Date.now() < until) {}
        process.send({ type: "event", channel: "photos-import-progress", data: { done: 1, total: 1 } })
        process.send({ type: "result", result: { imported: 1, reconciled: 0 } })
        process.disconnect()
      }, 10)
    })\n`
  )
  const db = openDatabase(databasePath)
  const events = new EventEmitter()
  let progress = null
  events.on("photos-import-progress", (value) => {
    progress = value
  })
  const workerStarted = new Promise((resolve) =>
    events.once("test-worker-started", resolve)
  )
  const scanner = createWatchScanner(db, events, {
    databasePath,
    workerPath,
    config: { mediaRoots: () => [] }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const scanning = scanner.scan()
  let scanFinished = false
  scanning.finally(() => {
    scanFinished = true
  })
  await workerStarted
  await delay(50)

  assert.equal(scanFinished, false)
  assert.deepEqual(await scanning, { imported: 1, reconciled: 0 })
  assert.deepEqual(progress, {
    done: 1,
    total: 1,
    file: null,
    complete: true
  })
})

test("worker failures terminate active import progress", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-worker-failure-")
  )
  const databasePath = path.join(directory, "cache.sqlite3")
  const workerPath = path.join(directory, "scan-worker.mjs")
  fs.writeFileSync(
    workerPath,
    `process.once("message", () => {
      process.send({ type: "event", channel: "photos-import-progress", data: { done: 1, total: 2, complete: false } })
      setTimeout(() => process.exit(1), 10)
    })\n`
  )
  const db = openDatabase(databasePath)
  const events = new EventEmitter()
  const progress = []
  events.on("photos-import-progress", (value) => progress.push(value))
  const scanner = createWatchScanner(db, events, {
    databasePath,
    workerPath,
    config: { mediaRoots: () => [] }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(scanner.scan(), /Media scan worker exited/)
  assert.deepEqual(progress.at(-1), {
    done: 1,
    total: 2,
    complete: true,
    file: null,
    error: "Media indexing failed"
  })
})

test("production scan worker shares the WAL cache without owning the parent connection", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-production-worker-")
  )
  const rootPath = path.join(directory, "media")
  const databasePath = path.join(directory, "cache.sqlite3")
  fs.mkdirSync(rootPath)
  const db = openDatabase(databasePath)
  const scanner = createWatchScanner(db, new EventEmitter(), {
    databasePath,
    config: {
      mediaRoots: () => [{ name: "photos", path: rootPath, enabled: true }]
    }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  assert.deepEqual(await scanner.scan(), { imported: 0, reconciled: 0 })
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )
})

test("worker scans and root mutations run serially", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-queue-"))
  const databasePath = path.join(directory, "cache.sqlite3")
  const workerPath = path.join(directory, "scan-worker.mjs")
  const lockPath = path.join(directory, "worker.lock")
  const overlapPath = path.join(directory, "overlap")
  fs.writeFileSync(
    workerPath,
    `import fs from "node:fs"
    process.once("message", (request) => {
      if (fs.existsSync(${JSON.stringify(lockPath)})) fs.writeFileSync(${JSON.stringify(overlapPath)}, request.operation)
      fs.writeFileSync(${JSON.stringify(lockPath)}, request.operation)
      setTimeout(() => {
        fs.rmSync(${JSON.stringify(lockPath)}, { force: true })
        process.send({ type: "result", result: { operation: request.operation } })
        process.disconnect()
      }, 100)
    })\n`
  )
  const db = openDatabase(databasePath)
  const scanner = createWatchScanner(db, new EventEmitter(), {
    databasePath,
    workerPath,
    config: { mediaRoots: () => [] }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const scanning = scanner.scan()
  const replacing = scanner.replaceRoot({
    name: "photos",
    path: directory,
    enabled: true
  })
  const pruning = scanner.pruneRootWhenIdle("photos")

  assert.deepEqual(await scanning, { operation: "scan" })
  assert.deepEqual(await replacing, { operation: "replace-root" })
  assert.deepEqual(await pruning, [])
  assert.equal(fs.existsSync(overlapPath), false)
})

test("stopping cancels worker operations queued during an active scan", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-stop-"))
  const databasePath = path.join(directory, "cache.sqlite3")
  const workerPath = path.join(directory, "scan-worker.mjs")
  fs.writeFileSync(
    workerPath,
    `process.once("message", (request) => {
      process.send({ type: "event", channel: "test-worker-started", data: request.operation })
      setTimeout(() => {
        process.send({ type: "result", result: request.operation })
        process.disconnect()
      }, 1000)
    })\n`
  )
  const db = openDatabase(databasePath)
  const events = new EventEmitter()
  const workerStarted = new Promise((resolve) =>
    events.once("test-worker-started", resolve)
  )
  const scanner = createWatchScanner(db, events, {
    databasePath,
    workerPath,
    config: { mediaRoots: () => [] }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const scanning = scanner.scan()
  assert.equal(await workerStarted, "scan")
  const replacing = scanner.replaceRoot({
    name: "photos",
    path: directory,
    enabled: true
  })
  const scanRejected = assert.rejects(scanning, /worker exited/)
  const replaceRejected = assert.rejects(replacing, /scanner is stopping/)

  await scanner.stop()
  await scanRejected
  await replaceRejected
})

test("stopping escalates when a scan worker ignores termination", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-stop-escalation-")
  )
  const databasePath = path.join(directory, "cache.sqlite3")
  const workerPath = path.join(directory, "scan-worker.mjs")
  const termPath = path.join(directory, "term-received")
  fs.writeFileSync(
    workerPath,
    `import fs from "node:fs"
    process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termPath)}, "yes"))
    process.once("message", () => {
      process.send({ type: "event", channel: "test-worker-started", data: true })
      setInterval(() => {}, 1000)
    })\n`
  )
  const db = openDatabase(databasePath)
  const events = new EventEmitter()
  const workerStarted = new Promise((resolve) =>
    events.once("test-worker-started", resolve)
  )
  const scanner = createWatchScanner(db, events, {
    databasePath,
    workerPath,
    config: { mediaRoots: () => [] }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const scanning = scanner.scan()
  await workerStarted
  const scanRejected = assert.rejects(scanning, /worker exited with SIGKILL/)
  const gracefulStop = scanner.stop()
  await waitFor(() => fs.existsSync(termPath))
  const startedAt = Date.now()
  await scanner.stop({ workerStopGraceMs: 50 })

  await gracefulStop
  await scanRejected
  assert.equal(fs.readFileSync(termPath, "utf8"), "yes")
  assert.ok(Date.now() - startedAt < 1_000)
})

test("scanner is read-only, path-derived, symlink-safe, and removes stale available-root rows", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-scan-"))
  const rootPath = path.join(directory, "media")
  const outside = path.join(directory, "outside.jpg")
  fs.mkdirSync(path.join(rootPath, ".nsfw", "travel", "trip"), {
    recursive: true
  })
  fs.mkdirSync(path.join(rootPath, ".hidden", "private"), { recursive: true })
  fs.mkdirSync(path.join(rootPath, ".ordinary"), { recursive: true })
  fs.mkdirSync(path.join(rootPath, ".records"), { recursive: true })
  fs.mkdirSync(path.join(rootPath, "records", "2026", "09", "18"), {
    recursive: true
  })
  const normal = path.join(rootPath, "normal.jpg")
  fs.writeFileSync(normal, "normal")
  fs.writeFileSync(
    path.join(rootPath, ".nsfw", "travel", "trip", "photo.jpg"),
    "nsfw"
  )
  fs.writeFileSync(
    path.join(rootPath, ".hidden", "private", "hidden.jpg"),
    "hidden"
  )
  fs.writeFileSync(path.join(rootPath, ".ordinary", "dot.jpg"), "dot")
  fs.writeFileSync(
    path.join(rootPath, "records", "2026", "09", "18", "added.jpg"),
    "added"
  )
  fs.writeFileSync(path.join(rootPath, ".records", "ignored.jpg"), "ignored")
  fs.writeFileSync(outside, "linked")
  fs.symlinkSync(outside, path.join(rootPath, "linked.jpg"))
  fs.symlinkSync(path.dirname(outside), path.join(rootPath, "linked-directory"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const roots = [{ name: "camera", path: rootPath, enabled: true }]
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: { mediaRoots: () => roots },
    readMediaMetadata: async () => ({ caption: "" })
  })

  assert.deepEqual(await scanner.scan(), { imported: 5, reconciled: 0 })
  assert.equal(fs.existsSync(`${normal}.md`), false)
  const rows = db
    .prepare("SELECT relative_path FROM attachments ORDER BY relative_path")
    .all()
  assert.deepEqual(
    rows.map((row) => row.relative_path),
    [
      ".hidden/private/hidden.jpg",
      ".nsfw/travel/trip/photo.jpg",
      ".ordinary/dot.jpg",
      "normal.jpg",
      "records/2026/09/18/added.jpg"
    ]
  )
  assert.equal(
    fs.lstatSync(path.join(rootPath, "linked.jpg")).isSymbolicLink(),
    true
  )

  fs.rmSync(normal)
  await scanner.scan()
  assert.equal(
    db
      .prepare("SELECT 1 FROM attachments WHERE relative_path = 'normal.jpg'")
      .get(),
    undefined
  )
  fs.renameSync(rootPath, `${rootPath}-offline`)
  await scanner.scan()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    4
  )
})

test("scanner reads an existing video companion but never creates one", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-lazy-companion-")
  )
  const media = path.join(directory, "clip.webm")
  fs.writeFileSync(media, "video")
  fs.writeFileSync(
    `${media}.md`,
    "---\nimportant: true\nfuture: keep\n---\n\nVideo caption\n"
  )
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  let durationSeconds = 4.25
  let photoFingerprints = 0
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    captionMetadata: {
      contentFingerprint: async () => {
        photoFingerprints += 1
        return "photo-pixels"
      }
    },
    readMediaMetadata: async () => ({
      createdAt: null,
      durationSeconds,
      exifData: null,
      latitude: null,
      longitude: null,
      mediaType: "video"
    })
  })
  await scanner.scan()
  const row = db
    .prepare(
      "SELECT content, duration_seconds, important, note_color FROM attachments"
    )
    .get()
  assert.deepEqual(
    { ...row },
    {
      content: "Video caption\n",
      duration_seconds: 4.25,
      important: 1,
      note_color: null
    }
  )
  assert.equal(
    db.prepare("SELECT mime_type FROM attachments").get().mime_type,
    "video/webm"
  )
  assert.equal(photoFingerprints, 0)

  durationSeconds = 5.5
  fs.appendFileSync(media, " updated")
  await scanner.scan()
  assert.equal(
    db.prepare("SELECT duration_seconds FROM attachments").get()
      .duration_seconds,
    5.5
  )
})

test("scanner restores durable media state after deleting the index", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-rebuild-"))
  const rootPath = path.join(directory, "media")
  const databasePath = path.join(directory, "index.sqlite3")
  fs.mkdirSync(path.join(rootPath, ".nsfw", "travel"), { recursive: true })
  const photo = path.join(rootPath, ".nsfw", "travel", "photo.jpg")
  const video = path.join(rootPath, "clip.webm")
  fs.writeFileSync(photo, "photo")
  fs.writeFileSync(video, "video")
  fs.writeFileSync(
    `${video}.md`,
    "---\ndate_override: 2026-09-03T10:11:12.000Z\nimportant: true\nnote_style:\n  color: butter\n---\n\nVideo caption\n"
  )
  const metadata = async (filePath) =>
    filePath.endsWith(".jpg")
      ? {
          caption: "Photo caption",
          captionConflict: false,
          createdAt: "2024-02-03T04:05:06.000Z",
          exifData: { DateTimeOriginal: "2024:02:03 04:05:06" },
          important: true,
          latitude: 50.1,
          longitude: 14.2,
          presentationColor: "mint"
        }
      : {
          createdAt: null,
          durationSeconds: 2.5,
          exifData: { DateTimeOriginal: null },
          latitude: null,
          longitude: null,
          mediaType: "video"
        }
  const options = {
    config: {
      mediaRoots: () => [{ name: "records", path: rootPath, enabled: true }]
    },
    captionMetadata: { contentFingerprint: async () => "pixels" },
    readMediaMetadata: metadata
  }
  const projection = (db) =>
    db
      .prepare(
        `SELECT root_name, relative_path, mime_type, byte_size, content,
                duration_seconds, important, note_color,
                content_fingerprint, exif_data, created_at
           FROM attachments ORDER BY relative_path`
      )
      .all()
      .map((row) => ({ ...row }))

  let db = openDatabase(databasePath)
  context.after(() => {
    db?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await createWatchScanner(db, new EventEmitter(), options).scan()
  const expected = projection(db)
  assert.deepEqual(
    expected.map((row) => [row.relative_path, row.note_color]),
    [
      [".nsfw/travel/photo.jpg", "mint"],
      ["clip.webm", "butter"]
    ]
  )
  db.close()
  db = null
  for (const suffix of ["", "-wal", "-shm"])
    fs.rmSync(`${databasePath}${suffix}`, { force: true })

  db = openDatabase(databasePath)
  await createWatchScanner(db, new EventEmitter(), options).scan()
  assert.deepEqual(projection(db), expected)
  const restoredVideo = db
    .prepare(
      "SELECT content, duration_seconds, important, note_color FROM attachments WHERE mime_type LIKE 'video/%'"
    )
    .get()
  assert.deepEqual(
    { ...restoredVideo },
    {
      content: "Video caption\n",
      duration_seconds: 2.5,
      important: 1,
      note_color: "butter"
    }
  )
})

test("media mutations survive index deletion and corruption without changing authoritative files", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-authority-lifecycle-")
  )
  const rootPath = path.join(directory, "media")
  const databasePath = path.join(directory, "index.sqlite3")
  fs.mkdirSync(rootPath)
  const photoPath = path.join(rootPath, "photo.jpg")
  const videoPath = path.join(rootPath, "clip.webm")
  fs.writeFileSync(photoPath, JSON.stringify({ pixels: "unchanged" }))
  fs.writeFileSync(videoPath, "video bytes")
  const config = {
    mediaRoots: () => [{ name: "records", path: rootPath, enabled: true }]
  }
  const readMediaMetadata = async (filePath) => {
    if (filePath === videoPath) {
      return { durationSeconds: 3.5, mediaType: "video" }
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
    const metadata = data.metadata || {}
    return {
      caption: metadata.caption || "",
      captionConflict: false,
      createdAt: metadata.createdAt || null,
      exifData: {
        ...(metadata.dateTimeOriginal && {
          DateTimeOriginal: metadata.dateTimeOriginal
        }),
        ...(metadata.offsetTimeOriginal && {
          OffsetTimeOriginal: metadata.offsetTimeOriginal
        }),
        ...(metadata.make && { Make: metadata.make }),
        ...(metadata.model && { Model: metadata.model })
      },
      important: metadata.important === true,
      latitude: metadata.latitude ?? null,
      longitude: metadata.longitude ?? null,
      presentationColor: metadata.presentationColor || null
    }
  }
  const captionMetadata = {
    contentFingerprint: async () => "stable-pixels",
    write: async (filePath, patch) => {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"))
      const createdAt = patch.createdAt || data.metadata?.createdAt || null
      const match =
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}).*(Z|[+-]\d{2}:\d{2})$/.exec(
          createdAt || ""
        )
      const offset = match?.[7] === "Z" ? "+00:00" : match?.[7] || null
      const metadata = {
        ...(data.metadata || {}),
        caption: patch.caption,
        important: patch.important,
        presentationColor: patch.presentationColor,
        createdAt,
        dateTimeOriginal: match
          ? `${match[1]}:${match[2]}:${match[3]} ${match[4]}:${match[5]}:${match[6]}`
          : null,
        offsetTimeOriginal: offset,
        make: patch.make,
        model: patch.model,
        latitude: patch.latitude,
        longitude: patch.longitude
      }
      fs.writeFileSync(filePath, JSON.stringify({ ...data, metadata }))
      return {
        embedded: {
          caption: metadata.caption,
          values: {
            xmp: metadata.caption,
            iptc: metadata.caption,
            exif: metadata.caption
          },
          important: metadata.important,
          presentationColor: metadata.presentationColor,
          createdAt: metadata.createdAt,
          dateTimeOriginal: metadata.dateTimeOriginal,
          offsetTimeOriginal: metadata.offsetTimeOriginal,
          make: metadata.make,
          model: metadata.model,
          latitude: metadata.latitude,
          longitude: metadata.longitude
        }
      }
    }
  }
  const scannerOptions = { config, captionMetadata, readMediaMetadata }
  const durableProjection = (db) =>
    db
      .prepare(
        `SELECT root_name, relative_path, mime_type, content, duration_seconds,
                important, note_color, content_fingerprint, exif_data, created_at
           FROM attachments ORDER BY relative_path`
      )
      .all()
      .map((row) => ({ ...row }))

  let db = openDatabase(databasePath)
  context.after(() => {
    db?.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  await createWatchScanner(db, new EventEmitter(), scannerOptions).scan()
  const rows = db
    .prepare("SELECT id, relative_path FROM attachments ORDER BY relative_path")
    .all()
  const photoId = rows.find((row) => row.relative_path === "photo.jpg").id
  const videoId = rows.find((row) => row.relative_path === "clip.webm").id
  await updateMediaAttachment(
    db,
    photoId,
    {
      content: "Photo caption",
      important: true,
      noteColor: "sky",
      createdAt: "2026-09-17T00:30:00+14:00",
      Make: "Records",
      Model: "Authority",
      latitude: 50.1,
      longitude: 14.2
    },
    { captionMetadata, config }
  )
  await updateMediaAttachment(
    db,
    videoId,
    {
      content: "Video caption",
      important: true,
      noteColor: "mint",
      createdAt: "2026-09-18T10:11:12.000Z"
    },
    { captionMetadata, config }
  )
  await createWatchScanner(db, new EventEmitter(), scannerOptions).scan()
  const expected = durableProjection(db)
  const authoritative = new Map(
    [photoPath, videoPath, `${videoPath}.md`].map((filePath) => [
      filePath,
      fs.readFileSync(filePath)
    ])
  )

  const rebuild = async (corrupt) => {
    db.close()
    db = null
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(`${databasePath}${suffix}`, { force: true })
    }
    if (corrupt) fs.writeFileSync(databasePath, "not sqlite")
    db = openDatabase(databasePath)
    await createWatchScanner(db, new EventEmitter(), scannerOptions).scan()
    assert.deepEqual(durableProjection(db), expected)
    for (const [filePath, bytes] of authoritative) {
      assert.deepEqual(fs.readFileSync(filePath), bytes)
    }
  }

  await rebuild(false)
  await rebuild(true)
  const photo = expected.find((row) => row.relative_path === "photo.jpg")
  assert.equal(photo.created_at, "2026-09-17T00:30:00+14:00")
  assert.equal(JSON.parse(photo.exif_data).OffsetTimeOriginal, "+14:00")
  const video = expected.find((row) => row.relative_path === "clip.webm")
  assert.equal(video.content, "Video caption\n")
  assert.equal(video.note_color, "mint")
})

test("media watcher debounces external filesystem changes into a scan", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-watch-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const handlers = new Map()
  const watcher = {
    close: async () => {},
    on(event, handler) {
      handlers.set(event, handler)
      return this
    }
  }
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => ({ mediaType: "video" }),
    watch: () => watcher
  })
  context.after(() => {
    scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.start()
  fs.writeFileSync(path.join(directory, "external.mp4"), "video")
  handlers.get("all")("add", path.join(directory, "external.mp4"))
  await new Promise((resolve) => setTimeout(resolve, 400))

  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    1
  )
})

test("scanner processes newest media first", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-order-"))
  const older = path.join(directory, "older.jpg")
  const newer = path.join(directory, "newer.jpg")
  fs.writeFileSync(older, "older")
  fs.writeFileSync(newer, "newer")
  fs.utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"))
  fs.utimesSync(newer, new Date("2026-09-18"), new Date("2026-09-18"))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(
    filesUnder(directory).map((item) => item.relativePath),
    ["newer.jpg", "older.jpg"]
  )
})

test("scanner ignores internal metadata staging images", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-staging-"))
  const temporary = path.join(
    directory,
    ".photo.records-caption-00000000-0000-0000-0000-000000000000.jpg"
  )
  fs.writeFileSync(temporary, "temporary")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.deepEqual(filesUnder(directory), [])
})

test("scanner ignores AppleDouble media sidecars", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-apple-double-")
  )
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, "photo.jpg"), "photo")
  fs.writeFileSync(path.join(directory, "._photo.jpg"), "apple-double")
  fs.writeFileSync(path.join(directory, "._clip.mp4"), "apple-double")

  assert.deepEqual(
    filesUnder(directory).map((item) => item.relativePath),
    ["photo.jpg"]
  )
})

test("filesystem changes during a scan schedule a follow-up scan", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-rescan-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const initial = path.join(directory, "initial.jpg")
  fs.writeFileSync(initial, "initial")
  const handlers = new Map()
  const watcher = {
    close: async () => {},
    on(event, handler) {
      handlers.set(event, handler)
      return this
    }
  }
  let releaseInitial
  const initialReleased = new Promise((resolve) => {
    releaseInitial = resolve
  })
  let notifyInitialStarted
  const initialStarted = new Promise((resolve) => {
    notifyInitialStarted = resolve
  })
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async (filePath) => {
      if (filePath === initial) {
        notifyInitialStarted()
        await initialReleased
      }
      return { caption: "" }
    },
    watch: () => watcher
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const starting = scanner.start()
  await initialStarted
  const added = path.join(directory, "added.jpg")
  fs.writeFileSync(added, "added")
  handlers.get("all")("add", added)
  await delay(300)
  releaseInitial()
  await starting

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count === 2
    )
      break
    await delay(25)
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    2
  )
})

test("scanner accepts silent and audio-bearing videos but rejects non-video candidates", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-video-"))
  for (const name of [
    "silent.webm",
    "with-audio.webm",
    "audio-only.webm",
    "failed.webm"
  ]) {
    fs.writeFileSync(path.join(directory, name), name)
  }
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async (filePath) => {
      const name = path.basename(filePath)
      if (name === "failed.webm") throw new Error("ffprobe failed")
      if (name === "audio-only.webm") {
        throw new Error("File does not contain a video stream")
      }
      return {
        durationSeconds: name === "silent.webm" ? 4 : 5,
        mediaType: "video"
      }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  assert.deepEqual(await scanner.scan(), { imported: 2, reconciled: 0 })
  assert.deepEqual(
    db
      .prepare(
        "SELECT relative_path, mime_type, duration_seconds FROM attachments ORDER BY relative_path"
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        relative_path: "silent.webm",
        mime_type: "video/webm",
        duration_seconds: 4
      },
      {
        relative_path: "with-audio.webm",
        mime_type: "video/webm",
        duration_seconds: 5
      }
    ]
  )
})

test("failed video probes reject candidates and retry unchanged media", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-fallback-"))
  const media = path.join(directory, "candidate.webm")
  fs.writeFileSync(media, "video")
  fs.writeFileSync(
    `${media}.md`,
    "---\ndate_override: 2026-09-01T02:03:04.000Z\nimportant: true\nnote_style:\n  color: mint\n---\n\nRecovered caption\n"
  )
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let attempts = 0
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      attempts += 1
      if (attempts === 1) throw new Error("ffprobe failed")
      return { durationSeconds: 7.5, mediaType: "video" }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )

  assert.deepEqual(await scanner.scan(), { imported: 1, reconciled: 0 })
  const retried = db
    .prepare(
      "SELECT content, created_at, duration_seconds, important, note_color, source_revision FROM attachments"
    )
    .get()
  assert.equal(attempts, 2)
  assert.equal(retried.content, "Recovered caption\n")
  assert.equal(retried.created_at, "2026-09-01T02:03:04.000Z")
  assert.equal(retried.duration_seconds, 7.5)
  assert.equal(retried.important, 1)
  assert.equal(retried.note_color, "mint")
  assert.equal(typeof retried.source_revision, "string")
})

test("scanner revision distinguishes roots with colliding file stats", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-revision-root-")
  )
  const oldRoot = path.join(directory, "old")
  const newRoot = path.join(directory, "new")
  fs.mkdirSync(oldRoot)
  fs.mkdirSync(newRoot)
  const oldMedia = path.join(oldRoot, "same.jpg")
  const newMedia = path.join(newRoot, "same.jpg")
  fs.writeFileSync(oldMedia, "same")
  fs.writeFileSync(newMedia, "same")
  const timestamp = new Date("2026-09-10T12:00:00.000Z")
  fs.utimesSync(oldMedia, timestamp, timestamp)
  fs.utimesSync(newMedia, timestamp, timestamp)
  const root = { name: "records", path: oldRoot, enabled: true }
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: { mediaRoots: () => [root] },
    readMediaMetadata: async (filePath) => ({
      caption: filePath.startsWith(newRoot) ? "new root" : "old root"
    })
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  const first = db
    .prepare("SELECT content, source_revision FROM attachments")
    .get()
  root.path = newRoot
  assert.deepEqual(await scanner.scan(), { imported: 0, reconciled: 1 })
  const repaired = db
    .prepare("SELECT content, source_revision FROM attachments")
    .get()
  assert.equal(repaired.content, "new root")
  assert.notEqual(repaired.source_revision, first.source_revision)
})

test("scanner detects same-mtime video companion content changes", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-revision-av-")
  )
  const media = path.join(directory, "clip.webm")
  const companion = `${media}.md`
  fs.writeFileSync(media, "video")
  fs.writeFileSync(companion, "---\nimportant: false\n---\n\nFirst\n")
  const companionTimes = fs.statSync(companion)
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => ({ mediaType: "video" })
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  const firstRevision = db
    .prepare("SELECT source_revision FROM attachments")
    .get().source_revision
  fs.writeFileSync(companion, "---\nimportant: false\n---\n\nOther\n")
  fs.utimesSync(companion, companionTimes.atime, companionTimes.mtime)
  assert.deepEqual(await scanner.scan(), { imported: 0, reconciled: 1 })
  const changed = db
    .prepare("SELECT content, source_revision FROM attachments")
    .get()
  assert.equal(changed.content, "Other\n")
  assert.notEqual(changed.source_revision, firstRevision)
})

test("failed initial photo extraction remains unprojected and retryable", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-photo-fallback-")
  )
  fs.writeFileSync(path.join(directory, "photo.jpg"), "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const events = new EventEmitter()
  const progress = []
  events.on("photos-import-progress", (value) => progress.push(value))
  let fail = true
  const scanner = createWatchScanner(db, events, {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      if (fail) throw new Error("identify failed")
      return { mediaType: "image" }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )
  assert.deepEqual(progress.at(-1), {
    done: 1,
    total: 1,
    indexed: 0,
    skipped: 1,
    errors: 1,
    rootName: "records",
    rootPath: directory,
    rootDone: 1,
    rootTotal: 1,
    file: null,
    complete: true
  })
  fail = false
  progress.length = 0
  await scanner.scan()
  const row = db
    .prepare(
      "SELECT mime_type, content, duration_seconds, note_color, exif_data, mtime_ms FROM attachments"
    )
    .get()
  assert.deepEqual(
    { ...row },
    {
      mime_type: "image/jpeg",
      content: "",
      duration_seconds: null,
      note_color: null,
      exif_data: null,
      mtime_ms: fs.statSync(path.join(directory, "photo.jpg")).mtimeMs
    }
  )
  assert.deepEqual(progress.at(-1), {
    done: 1,
    total: 1,
    indexed: 1,
    skipped: 0,
    errors: 0,
    rootName: "records",
    rootPath: directory,
    rootDone: 1,
    rootTotal: 1,
    file: null,
    complete: true
  })
})

test("transient photo extraction failure preserves established metadata and retries", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-photo-preserve-")
  )
  const media = path.join(directory, "photo.jpg")
  fs.writeFileSync(media, "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let fail = false
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      if (fail) throw new Error("temporary identify failure")
      return {
        caption: "Durable caption",
        createdAt: "2025-04-03T02:01:00.000Z",
        exifData: { Make: "Camera" },
        important: true,
        latitude: 50,
        longitude: 14,
        mediaType: "image",
        presentationColor: "mint"
      }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  fail = true
  fs.appendFileSync(media, " changed")
  await scanner.scan()
  const preserved = db.prepare("SELECT * FROM attachments").get()
  assert.equal(preserved.content, "Durable caption")
  assert.equal(preserved.created_at, "2025-04-03T02:01:00.000Z")
  assert.equal(preserved.important, 1)
  assert.equal(preserved.note_color, "mint")
  assert.equal(preserved.source_revision, null)
  assert.deepEqual(JSON.parse(preserved.exif_data), {
    Make: "Camera",
    latitude: 50,
    longitude: 14
  })

  fail = false
  await scanner.scan()
  assert.equal(
    typeof db.prepare("SELECT source_revision FROM attachments").get()
      .source_revision,
    "string"
  )
})

test("failed date repair replaces an invalid cached timestamp with filesystem time", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-photo-date-fallback-")
  )
  const media = path.join(directory, "photo.jpg")
  fs.writeFileSync(media, "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let fail = false
  let reads = 0
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      reads += 1
      if (fail) throw new Error("temporary identify failure")
      return {
        caption: "Durable caption",
        createdAt: "2025-04-03T02:01:00.000Z",
        exifData: { Make: "Camera" },
        important: true,
        mediaType: "image",
        presentationColor: "mint"
      }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  db.prepare(
    "UPDATE attachments SET created_at = '2025-04-03Tnot-a-time'"
  ).run()
  fail = true

  await scanner.scan()
  const fallback = db.prepare("SELECT * FROM attachments").get()
  assert.equal(reads, 2)
  assert.equal(fallback.created_at, fs.statSync(media).mtime.toISOString())
  assert.equal(fallback.content, "Durable caption")
  assert.equal(fallback.important, 1)
  assert.equal(fallback.note_color, "mint")
  assert.equal(fallback.source_revision, null)
  assert.deepEqual(JSON.parse(fallback.exif_data), { Make: "Camera" })

  await scanner.scan()
  assert.equal(reads, 3)
  assert.equal(
    db.prepare("SELECT created_at FROM attachments").get().created_at,
    fs.statSync(media).mtime.toISOString()
  )

  fail = false
  await scanner.scan()
  const repaired = db.prepare("SELECT * FROM attachments").get()
  assert.equal(reads, 4)
  assert.equal(repaired.created_at, "2025-04-03T02:01:00.000Z")
  assert.equal(typeof repaired.source_revision, "string")
})

test("transient video extraction failure preserves and retries the established projection", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-preserve-"))
  const media = path.join(directory, "clip.webm")
  fs.writeFileSync(media, "video")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let fail = false
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      if (fail) throw new Error("temporary failure")
      return {
        createdAt: "2024-03-02T01:02:03.000Z",
        durationSeconds: 12.5,
        exifData: { DateTimeOriginal: "2024-03-02T01:02:03.000Z" },
        mediaType: "video"
      }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  const before = db.prepare("SELECT * FROM attachments").get()
  fail = true
  fs.appendFileSync(media, " changed")
  await scanner.scan()

  const preserved = db.prepare("SELECT * FROM attachments").get()
  assert.equal(preserved.id, before.id)
  assert.equal(preserved.source_revision, before.source_revision)
  assert.equal(preserved.duration_seconds, 12.5)

  fail = false
  await scanner.scan()
  const recovered = db.prepare("SELECT * FROM attachments").get()
  assert.equal(recovered.id, before.id)
  assert.notEqual(recovered.source_revision, before.source_revision)
})

test("a conclusive no-video probe removes a stale video projection", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-no-video-"))
  const media = path.join(directory, "clip.webm")
  fs.writeFileSync(media, "video")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let admitted = true
  const { UnsupportedMediaError } =
    await import("../../runtime/media-metadata.js")
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      if (admitted) return { mediaType: "video" }
      throw new UnsupportedMediaError("File does not contain a video stream", {
        reason: "no-video-stream"
      })
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  admitted = false
  fs.appendFileSync(media, " changed")
  await scanner.scan()
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )
})

test("unsupported photo color does not discard other projected metadata", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-color-"))
  fs.writeFileSync(path.join(directory, "photo.jpg"), "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => ({
      caption: "Caption",
      createdAt: "2025-01-02T03:04:05.000Z",
      exifData: { Make: "Camera" },
      important: true,
      latitude: 50,
      longitude: 14,
      presentationColor: "orange"
    })
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  const row = db
    .prepare(
      "SELECT content, important, note_color, exif_data, created_at FROM attachments"
    )
    .get()
  assert.equal(row.content, "Caption")
  assert.equal(row.important, 1)
  assert.equal(row.note_color, null)
  assert.deepEqual(JSON.parse(row.exif_data), {
    Make: "Camera",
    latitude: 50,
    longitude: 14
  })
  assert.equal(row.created_at, "2025-01-02T03:04:05.000Z")
})

test("offline enabled roots are retained while disabled roots are pruned with snapshots", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-roots-"))
  const onlinePath = path.join(directory, "online")
  const disabledPath = path.join(directory, "disabled")
  fs.mkdirSync(onlinePath)
  fs.mkdirSync(disabledPath)
  fs.writeFileSync(path.join(onlinePath, "online.mp4"), "online")
  fs.writeFileSync(path.join(disabledPath, "disabled.mp4"), "disabled")
  const roots = [
    { name: "online", path: onlinePath, enabled: true },
    { name: "disabled", path: disabledPath, enabled: true }
  ]
  const invalidated = []
  const events = new EventEmitter()
  const changes = []
  events.on("data-changed", (event) => changes.push(event))
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const scanner = createWatchScanner(db, events, {
    config: { mediaRoots: () => roots },
    onAttachmentChanged: (attachment) => invalidated.push(attachment),
    readMediaMetadata: async () => ({ mediaType: "video" })
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  changes.length = 0
  fs.renameSync(onlinePath, `${onlinePath}-offline`)
  roots[1].enabled = false
  assert.deepEqual(await scanner.scan(), {
    imported: 0,
    reconciled: 0,
    removed: 1
  })
  assert.deepEqual(
    db
      .prepare("SELECT root_name FROM attachments ORDER BY root_name")
      .all()
      .map((row) => row.root_name),
    ["online"]
  )
  assert.equal(invalidated.length, 1)
  assert.equal(invalidated[0].relative_path, "disabled.mp4")
  assert.equal(
    invalidated[0].file_path,
    path.join(disabledPath, "disabled.mp4")
  )
  assert.deepEqual(changes, [
    {
      method: "media:scan",
      imported: 0,
      reconciled: 0,
      removed: 1
    }
  ])
})

test("root projection can be staged and transactionally replaced", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-replace-"))
  const oldPath = path.join(directory, "old")
  const nextPath = path.join(directory, "next")
  fs.mkdirSync(oldPath)
  fs.mkdirSync(nextPath)
  fs.writeFileSync(path.join(oldPath, "same.jpg"), "old")
  fs.writeFileSync(path.join(nextPath, "same.jpg"), "new")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const configRoot = { name: "records", path: oldPath, enabled: true }
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: { mediaRoots: () => [configRoot] },
    readMediaMetadata: async (filePath) => ({
      caption: filePath.startsWith(nextPath) ? "New caption" : "Old caption"
    })
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  const staged = await scanner.stageRoot(
    { name: "records", path: nextPath, enabled: true },
    { replace: true }
  )
  assert.equal(
    db.prepare("SELECT content FROM attachments").get().content,
    "Old caption"
  )
  assert.throws(
    () =>
      runTransaction(db, () => {
        scanner.commitRoot(staged, {
          replace: true,
          emit: false,
          notify: false
        })
        throw new Error("abort switch")
      }),
    /abort switch/
  )
  assert.equal(
    db.prepare("SELECT content FROM attachments").get().content,
    "Old caption"
  )
  const result = await scanner.replaceRoot(staged)
  assert.equal(result.imported, 1)
  assert.equal(result.removed, 1)
  assert.equal(
    result.removedAttachments[0].file_path,
    path.join(oldPath, "same.jpg")
  )
  assert.equal(
    db.prepare("SELECT content FROM attachments").get().content,
    "New caption"
  )
})

test("scanner start resolves only after initial reconstruction", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-start-"))
  fs.writeFileSync(path.join(directory, "photo.jpg"), "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let release
  const extraction = new Promise((resolve) => {
    release = resolve
  })
  const watcher = { close: async () => {}, on: () => watcher }
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      await extraction
      return { caption: "" }
    },
    watch: () => watcher
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  let started = false
  const starting = scanner.start().then(() => {
    started = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started, false)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )
  release()
  await starting
  assert.equal(started, true)
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    1
  )
})

test("scanner exposes completed projections before a long scan finishes", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-incremental-scan-")
  )
  fs.writeFileSync(path.join(directory, "one.jpg"), "one")
  fs.writeFileSync(path.join(directory, "two.jpg"), "two")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let releaseSecond
  const secondStarted = new Promise((resolve) => {
    releaseSecond = resolve
  })
  let reads = 0
  let continueSecond
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      reads += 1
      if (reads === 2) {
        releaseSecond()
        await new Promise((resolve) => {
          continueSecond = resolve
        })
      }
      return { mediaType: "image" }
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const scan = scanner.scan()
  await secondStarted
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    1
  )
  continueSecond()
  await scan
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    2
  )
})

test("scan progress aggregates roots and completes cached scans", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-aggregate-progress-")
  )
  const firstRoot = path.join(directory, "first")
  const secondRoot = path.join(directory, "second")
  fs.mkdirSync(firstRoot)
  fs.mkdirSync(secondRoot)
  fs.writeFileSync(path.join(firstRoot, "one.jpg"), "one")
  fs.writeFileSync(path.join(secondRoot, "two.jpg"), "two")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const events = new EventEmitter()
  const progress = []
  let reads = 0
  events.on("photos-import-progress", (value) => progress.push(value))
  const scanner = createWatchScanner(db, events, {
    config: {
      mediaRoots: () => [
        { name: "first", path: firstRoot, enabled: true },
        { name: "second", path: secondRoot, enabled: true }
      ]
    },
    readMediaMetadata: async () => {
      reads += 1
      return { caption: "" }
    }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  assert.equal(reads, 2)
  assert.ok(progress.every((value) => value.total === 2))
  assert.deepEqual(progress.at(-1), {
    done: 2,
    total: 2,
    indexed: 2,
    skipped: 0,
    errors: 0,
    rootName: "second",
    rootPath: secondRoot,
    rootDone: 1,
    rootTotal: 1,
    file: null,
    complete: true
  })
  assert.deepEqual(
    progress.map((value) => value.done),
    [...progress.map((value) => value.done)].sort((left, right) => left - right)
  )

  progress.length = 0
  await scanner.scan()
  assert.equal(reads, 2)
  assert.ok(progress.every((value) => value.total === 2))
  assert.ok(
    progress.some((value) => value.done === 2 && value.complete === false)
  )
  assert.deepEqual(progress.at(-1), {
    done: 2,
    total: 2,
    indexed: 2,
    skipped: 0,
    errors: 0,
    rootName: "second",
    rootPath: secondRoot,
    rootDone: 1,
    rootTotal: 1,
    file: null,
    complete: true
  })
})

test("incremental scans repair cached invalid capture dates", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-invalid-date-")
  )
  fs.writeFileSync(path.join(directory, "photo.jpg"), "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  let reads = 0
  const scanner = createWatchScanner(db, new EventEmitter(), {
    config: {
      mediaRoots: () => [{ name: "records", path: directory, enabled: true }]
    },
    readMediaMetadata: async () => {
      reads += 1
      return {
        caption: "",
        createdAt: "2024-02-03T00:30:00+14:00",
        mediaType: "image"
      }
    }
  })
  context.after(async () => {
    await scanner.stop()
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await scanner.scan()
  assert.equal(reads, 1)
  await scanner.scan()
  assert.equal(reads, 1)
  db.prepare(
    "UPDATE attachments SET created_at = '2024-02-03Tnot-a-time'"
  ).run()

  await scanner.scan()
  assert.equal(reads, 2)
  assert.equal(
    db.prepare("SELECT created_at FROM attachments").get().created_at,
    "2024-02-03T00:30:00+14:00"
  )
})
