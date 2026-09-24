import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { openDatabase } from "../../runtime/database.js"
import { createRpc } from "../../runtime/rpc.js"
import * as days from "../../runtime/src/repositories/days.js"
import * as messages from "../../runtime/src/repositories/messages.js"
import { DuplicateStore } from "../../runtime/src/services/duplicate-store.js"

function fixture(context, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-rpc-"))
  const databasePath = path.join(directory, "cache.sqlite3")
  const db = openDatabase(databasePath)
  const duplicateStore = new DuplicateStore(path.join(directory, "duplicates"))
  const trashService = options.trashService || {
    available: true,
    move: async (filePath) => {
      fs.rmSync(filePath, { recursive: true })
    }
  }
  const events = options.events || new EventEmitter()
  const call = createRpc(db, events, {
    databasePath,
    defaultMediaRoot: path.join(directory, "media"),
    duplicateStore,
    trashService,
    choosePath: options.choosePath,
    readMediaMetadata: options.readMediaMetadata,
    thumbnails: options.thumbnails || { available: false },
    watchScanner: options.watchScanner || {
      requestScan: () => {},
      scan: async () => ({ imported: 0, reconciled: 0 })
    },
    config: options.config,
    cacheDirectory: options.cacheDirectory,
    clearStreamableVideos: options.clearStreamableVideos,
    pruneStreamableVideo: options.pruneStreamableVideo,
    readMediaCompanion: options.readMediaCompanion,
    writeMediaCompanion: options.writeMediaCompanion,
    captionMetadata: options.captionMetadata || {
      capabilities: () => ({ read: true, write: true }),
      write: async (filePath, patch) => ({
        caption: typeof patch === "string" ? patch : patch.caption,
        checksum: "updated",
        byteSize: fs.statSync(filePath).size,
        mtimeMs: fs.statSync(filePath).mtimeMs,
        embedded: { caption: patch, values: {} }
      })
    }
  })
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, db, call, duplicateStore, events }
}

function addImage(directory, db, content = "photo bytes") {
  const mediaRoot = path.join(directory, "media")
  fs.mkdirSync(mediaRoot, { recursive: true })
  const filePath = path.join(mediaRoot, "photo.jpg")
  fs.writeFileSync(filePath, content)
  return messages.addPhoto(
    db,
    "2026-09-03",
    filePath,
    "photo.jpg",
    "image/jpeg",
    Buffer.byteLength(content),
    "checksum",
    { Make: "Old Camera" },
    null,
    null,
    null,
    "2026-09-03T10:00:00.000Z",
    { name: "records", path: mediaRoot },
    "old caption"
  )
}

function addVideo(directory, db, content = "video bytes") {
  const mediaRoot = path.join(directory, "media")
  fs.mkdirSync(mediaRoot, { recursive: true })
  const filePath = path.join(mediaRoot, "clip.mp4")
  fs.writeFileSync(filePath, content)
  return messages.addPhoto(
    db,
    "2026-09-03",
    filePath,
    "clip.mp4",
    "video/mp4",
    Buffer.byteLength(content),
    "video-checksum",
    null,
    null,
    null,
    null,
    "2026-09-03T10:00:00.000Z",
    { name: "records", path: mediaRoot },
    ""
  )
}

test("explicit RPC map rejects retired repositories and day selections", async (context) => {
  const { call } = fixture(context)
  for (const method of [
    "tags:list",
    "photo-groups:list",
    "days:set-photo-of-day",
    "days:clear-photo-of-day",
    "messages:update",
    "messages:update-photo-caption",
    "messages:update-timestamp",
    "attachments:list-scan-duplicates",
    "attachments:adopt-scan-duplicate-path",
    "attachments:remove-scan-duplicate",
    "attachments:list-duplicates",
    "attachments:get-duplicate-canonical",
    "attachments:confirm-duplicate-resolution",
    "storage:get-managed-media-root",
    "storage:pick-managed-media-root",
    "storage:get-records-folder",
    "storage:pick-records-folder",
    "watch-dirs:list",
    "watch-dirs:add",
    "watch-dirs:remove",
    "watch-dirs:toggle",
    "location:resolve",
    "profiles:pick-directory"
  ]) {
    await assert.rejects(call(method), /Unsupported method/)
  }
})

test("media-folder mutations queue reconciliation and prune only derivatives", async (context) => {
  const watched = fs.mkdtempSync(path.join(os.tmpdir(), "records-watched-"))
  const mediaPath = path.join(watched, "clip.mp4")
  fs.writeFileSync(mediaPath, "video")
  context.after(() => fs.rmSync(watched, { recursive: true, force: true }))
  const changes = []
  const events = new EventEmitter()
  events.on("data-changed", (event) => changes.push(event))
  const invalidated = []
  const pruned = []
  let scansRequested = 0
  let synchronized = 0
  const snapshot = {
    file_path: mediaPath,
    relative_path: "clip.mp4",
    relativePath: "clip.mp4"
  }
  const { call, directory } = fixture(context, {
    events,
    choosePath: async () => watched,
    thumbnails: {
      available: false,
      invalidate: (source) => invalidated.push(source)
    },
    pruneStreamableVideo: async (_cacheDirectory, source) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      pruned.push(source)
    },
    watchScanner: {
      requestScan: () => {
        scansRequested += 1
      },
      pruneRootWhenIdle: async () => [snapshot],
      syncWatchers: () => {
        synchronized += 1
      }
    }
  })

  const added = await call("media-folders:add")
  assert.equal(scansRequested, 1)
  assert.equal(added.path, watched)
  assert.equal(added.isDefault, false)
  await call("media-folders:set-default", [watched])
  await assert.rejects(
    call("media-folders:toggle", [watched, false]),
    /another default/
  )
  await assert.rejects(
    call("media-folders:remove", [watched]),
    /another default/
  )
  await call("media-folders:set-default", [path.join(directory, "media")])
  await assert.rejects(
    call("media-folders:toggle", [watched, "false"]),
    /must be boolean/
  )
  const disabled = await call("media-folders:toggle", [watched, false])
  assert.equal(disabled.enabled, false)
  assert.deepEqual(invalidated, [snapshot])
  assert.deepEqual(pruned, [snapshot])
  assert.equal(fs.existsSync(mediaPath), true)
  assert.equal(await call("media-folders:remove", [watched]), true)
  assert.equal(await call("media-folders:remove", [watched]), false)
  assert.equal(fs.existsSync(mediaPath), true)
  assert.equal(synchronized, 3)
  assert.deepEqual(
    changes.map((event) => event.method),
    [
      "media-folders:add",
      "media-folders:set-default",
      "media-folders:set-default",
      "media-folders:toggle",
      "media-folders:remove",
      "media-folders:remove"
    ]
  )
})

test("picked media uses file-backed date and metadata projection", async (context) => {
  const sourceDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-pick-source-")
  )
  const sourcePath = path.join(sourceDirectory, "photo.jpg")
  fs.writeFileSync(sourcePath, "photo")
  context.after(() =>
    fs.rmSync(sourceDirectory, { recursive: true, force: true })
  )
  const { db, call } = fixture(context, {
    choosePath: async () => sourcePath,
    readMediaMetadata: async () => ({
      caption: "Embedded caption",
      captionConflict: false,
      createdAt: "2024-02-03T04:05:06.000Z",
      exifData: { DateTimeOriginal: "2024:02:03 04:05:06" },
      important: true,
      latitude: 50.1,
      longitude: 14.2,
      presentationColor: "mint"
    })
  })
  const selectedDay = days.ensure(db, "2026-09-03")

  const imported = await call("attachments:pick-and-add", [selectedDay.id])
  assert.match(imported.attachment.relative_path, /^records\/2026\/09\/03\//)
  assert.equal(imported.message.created_at, "2024-02-03T04:05:06.000Z")
  assert.equal(imported.message.content, "Embedded caption")
  assert.deepEqual(imported.message.metadata, {
    important: true,
    note_style: { color: "mint" }
  })
  assert.equal(
    db
      .prepare(
        "SELECT substr(created_at, 1, 10) AS date FROM attachments WHERE id = ?"
      )
      .get(imported.message.id).date,
    "2024-02-03"
  )
  const updated = await call("attachments:update", [
    imported.attachment.id,
    {
      Make: "Records Camera"
    }
  ])
  assert.equal(updated.exif_data.Make, "Records Camera")
})

test("picked media requires a default and rejects an unsafe records child", async (context) => {
  let chooserCalls = 0
  const settings = new Map()
  const emptyConfig = {
    mediaRoots: () => [],
    defaultMediaRoot: () => null,
    allSettings: () => Object.fromEntries(settings),
    setSetting: (key, value) => {
      settings.set(key, value)
      return { key, value }
    }
  }
  const empty = fixture(context, {
    config: emptyConfig,
    choosePath: async () => {
      chooserCalls += 1
      return null
    }
  })
  await assert.rejects(
    empty.call("attachments:pick-and-add", ["2026-09-03"]),
    /Choose a default media folder/
  )
  assert.equal(chooserCalls, 0)

  const sourceDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-pick-unsafe-")
  )
  context.after(() =>
    fs.rmSync(sourceDirectory, { recursive: true, force: true })
  )
  const source = path.join(sourceDirectory, "photo.jpg")
  const outside = path.join(sourceDirectory, "outside")
  fs.writeFileSync(source, "photo")
  fs.mkdirSync(outside)
  const unsafe = fixture(context, { choosePath: async () => source })
  fs.symlinkSync(outside, path.join(unsafe.directory, "media", "records"))
  const day = days.ensure(unsafe.db, "2026-09-03")
  await assert.rejects(
    unsafe.call("attachments:pick-and-add", [day.id]),
    /records folder must be an ordinary directory/
  )
  assert.deepEqual(fs.readdirSync(outside), [])
  assert.equal(fs.readFileSync(source, "utf8"), "photo")
})

test("media updates reject arbitrary and extractor-owned fields", async (context) => {
  const { directory, db, call } = fixture(context)
  const video = addVideo(directory, db)
  for (const fields of [
    { metadata: { arbitrary: true } },
    { duration_seconds: 99 },
    { address: "Prague" },
    { weather: { summary: "Sunny" } }
  ]) {
    await assert.rejects(
      call("attachments:update", [video.attachment.id, fields]),
      /Unsupported media fields/
    )
  }
  await assert.rejects(
    call("attachments:update", [video.attachment.id, { noteColor: "orange" }]),
    /invalid note color/i
  )
  const row = db
    .prepare(
      "SELECT duration_seconds, note_color FROM attachments WHERE id = ?"
    )
    .get(video.attachment.id)
  assert.deepEqual(
    { ...row },
    {
      duration_seconds: null,
      note_color: null
    }
  )
})

test("attachment update rejects invalid patches before image writes or projection changes", async (context) => {
  let writes = 0
  const { directory, db, call } = fixture(context, {
    captionMetadata: {
      write: async () => {
        writes += 1
        throw new Error("writer must not run")
      }
    }
  })
  const image = addImage(directory, db)
  const id = image.attachment.id
  const source = fs.readFileSync(image.attachment.file_path)
  const before = {
    ...db.prepare("SELECT * FROM attachments WHERE id = ?").get(id)
  }
  const invalid = [
    null,
    [],
    "content",
    {},
    { arbitrary: true },
    { content: null },
    { important: 1 },
    { important: "false" },
    { noteColor: 1 },
    { noteColor: "orange" },
    { noteColor: undefined },
    { createdAt: null },
    { createdAt: "" },
    { createdAt: "2026-02-30T10:00:00Z" },
    { Make: 1 },
    { Model: false },
    { content: "bad\0caption" },
    { latitude: 1 },
    { longitude: 1 },
    { latitude: null, longitude: 1 },
    { latitude: Number.NaN, longitude: 1 },
    { latitude: 91, longitude: 1 },
    { latitude: 1, longitude: Number.POSITIVE_INFINITY },
    { latitude: 1, longitude: -181 }
  ]

  for (const fields of invalid) {
    await assert.rejects(call("attachments:update", [id, fields]))
    assert.equal(writes, 0, JSON.stringify(fields))
    assert.deepEqual(fs.readFileSync(image.attachment.file_path), source)
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) },
      before
    )
  }
})

test("video update rejects image-only fields before companion writes", async (context) => {
  let writes = 0
  const { directory, db, call } = fixture(context, {
    writeMediaCompanion: () => {
      writes += 1
      throw new Error("writer must not run")
    }
  })
  const video = addVideo(directory, db)
  const id = video.attachment.id
  const source = fs.readFileSync(video.attachment.file_path)
  const before = {
    ...db.prepare("SELECT * FROM attachments WHERE id = ?").get(id)
  }

  for (const fields of [
    { Make: "Camera" },
    { Model: null },
    { latitude: null, longitude: null }
  ]) {
    await assert.rejects(
      call("attachments:update", [id, fields]),
      /only supported for images/
    )
    assert.equal(writes, 0)
    assert.deepEqual(fs.readFileSync(video.attachment.file_path), source)
    assert.equal(fs.existsSync(`${video.attachment.file_path}.md`), false)
    assert.deepEqual(
      { ...db.prepare("SELECT * FROM attachments WHERE id = ?").get(id) },
      before
    )
  }
})

test("attachment update rejects missing files and symlinks before writing", async (context) => {
  let writes = 0
  const { directory, db, call } = fixture(context, {
    captionMetadata: {
      write: async () => {
        writes += 1
      }
    }
  })
  const image = addImage(directory, db)
  const before = {
    ...db
      .prepare("SELECT * FROM attachments WHERE id = ?")
      .get(image.attachment.id)
  }
  fs.rmSync(image.attachment.file_path)
  await assert.rejects(
    call("attachments:update", [image.attachment.id, { noteColor: "sky" }]),
    /missing/
  )
  fs.symlinkSync(
    path.join(directory, "missing-target"),
    image.attachment.file_path
  )
  await assert.rejects(
    call("attachments:update", [image.attachment.id, { noteColor: "sky" }]),
    /symlink/
  )
  assert.equal(writes, 0)
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT * FROM attachments WHERE id = ?")
        .get(image.attachment.id)
    },
    before
  )
})

test("valid photo update writes every field and returns the projected attachment", async (context) => {
  const written = []
  const { directory, db, call } = fixture(context, {
    captionMetadata: {
      write: async (_filePath, patch) => {
        written.push(patch)
        return {
          embedded: {
            values: {
              xmp: patch.caption,
              iptc: patch.caption,
              exif: patch.caption
            }
          }
        }
      }
    }
  })
  const image = addImage(directory, db)
  const updated = await call("attachments:update", [
    image.attachment.id,
    {
      content: "new caption",
      important: true,
      noteColor: "lavender",
      createdAt: "2026-09-04T11:12:13.000Z",
      Make: "Records Camera",
      Model: null,
      latitude: 50.1,
      longitude: 14.2
    }
  ])
  assert.deepEqual(written, [
    {
      caption: "new caption",
      important: true,
      presentationColor: "lavender",
      createdAt: "2026-09-04T11:12:13.000Z",
      make: "Records Camera",
      model: null,
      latitude: 50.1,
      longitude: 14.2
    }
  ])
  assert.equal(updated.id, image.attachment.id)
  assert.equal(updated.created_at, "2026-09-04T11:12:13.000Z")
  assert.equal(updated.exif_data.DateTimeOriginal, "2026:09:04 11:12:13")
  assert.equal(updated.exif_data.Make, "Records Camera")
  assert.equal(updated.exif_data.Model, undefined)
  assert.equal(updated.latitude, 50.1)
  assert.equal(updated.longitude, 14.2)
  const row = db
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(updated.id)
  assert.equal(row.content, "new caption")
  assert.equal(row.important, 1)
  assert.equal(row.note_color, "lavender")
})

test("valid video update writes its companion and projection", async (context) => {
  const { directory, db, call } = fixture(context)
  const video = addVideo(directory, db)
  const updated = await call("attachments:update", [
    video.attachment.id,
    {
      content: "video caption",
      important: true,
      noteColor: "mint",
      createdAt: "2026-09-04T11:12:13.000Z"
    }
  ])
  const companion = fs.readFileSync(`${video.attachment.file_path}.md`, "utf8")
  assert.match(companion, /important: true/)
  assert.match(companion, /color: mint/)
  assert.match(companion, /date_override: 2026-09-04T11:12:13.000Z/)
  assert.match(companion, /video caption/)
  assert.equal(updated.created_at, "2026-09-04T11:12:13.000Z")
  const row = db
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(updated.id)
  assert.equal(row.content, "video caption\n")
  assert.equal(row.important, 1)
  assert.equal(row.note_color, "mint")
})

test("visibility RPC moves media with its companion and updates cache identity", async (context) => {
  const { directory, db, call } = fixture(context)
  const video = addVideo(directory, db)
  await call("attachments:update", [video.message.id, { content: "body" }])
  db.prepare(
    "UPDATE attachments SET source_revision = 'confirmed' WHERE id = ?"
  ).run(video.attachment.id)
  const moved = await call("messages:set-visibility", [
    video.message.id,
    ".private"
  ])
  const attachment = db
    .prepare("SELECT * FROM attachments WHERE id = ?")
    .get(video.attachment.id)
  const hydrated = await call("attachments:get", [video.attachment.id])
  assert.equal(moved.visibility, ".private")
  assert.match(attachment.relative_path, /^\.hidden\/private\//)
  assert.equal(attachment.source_revision, null)
  assert.equal(fs.existsSync(hydrated.file_path), true)
  assert.equal(fs.existsSync(`${hydrated.file_path}.md`), true)
})

test("trash deletes disposable projection without tombstones or restore APIs", async (context) => {
  const { directory, db, call } = fixture(context)
  const video = addVideo(directory, db)
  await call("attachments:update", [video.attachment.id, { content: "body" }])
  await call("messages:delete", [video.message.id])
  assert.equal(fs.existsSync(video.attachment.file_path), false)
  assert.equal(
    db.prepare("SELECT * FROM attachments WHERE id = ?").get(video.message.id),
    undefined
  )
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'trash_tombstones'")
      .get(),
    undefined
  )
  await assert.rejects(call("trash:restore"), /Unsupported method/)
})

test("failed system Trash leaves file and projection intact", async (context) => {
  const { directory, db, call } = fixture(context, {
    trashService: {
      available: true,
      move: async () => {
        throw new Error("trash failed")
      }
    }
  })
  const video = addVideo(directory, db)
  await assert.rejects(
    call("messages:delete", [video.message.id]),
    /trash failed/
  )
  assert.equal(fs.existsSync(video.attachment.file_path), true)
  assert.ok(
    db.prepare("SELECT * FROM attachments WHERE id = ?").get(video.message.id)
  )
})

test("duplicate canonical choice lives in YAML and survives cache deletion", async (context) => {
  const { directory, db, call, duplicateStore } = fixture(context)
  const day = days.ensure(db, "2026-09-03")
  const rootPath = path.join(directory, "dupes")
  fs.mkdirSync(rootPath)
  const root = { name: "camera", path: rootPath }
  const items = ["one.mp4", "two.mp4"].map((name) => {
    const filePath = path.join(rootPath, name)
    fs.writeFileSync(filePath, "same")
    return messages.addPhoto(
      db,
      day.id,
      filePath,
      name,
      "video/mp4",
      4,
      "same",
      null,
      null,
      null,
      null,
      "2026-09-03T10:00:00Z",
      root
    )
  })
  db.prepare("UPDATE attachments SET content_fingerprint = 'same'").run()
  await call("attachments:set-duplicate-canonical", [
    "same",
    items[1].attachment.id
  ])
  assert.deepEqual(duplicateStore.read("same").canonical, {
    root: "camera",
    path: "two.mp4"
  })
  db.prepare("DELETE FROM attachments").run()
  assert.deepEqual(duplicateStore.read("same").canonical, {
    root: "camera",
    path: "two.mp4"
  })
})

test("calendar, media, and duplicate RPC paths are callable", async (context) => {
  const { directory, db, call } = fixture(context, {
    thumbnails: {
      available: false,
      generate: async () => null,
      regenerate: async () => null
    }
  })
  const imageA = addImage(directory, db, "same")
  const secondPath = path.join(directory, "media", "second.jpg")
  fs.writeFileSync(secondPath, "same")
  messages.addPhoto(
    db,
    "2025-09-17",
    secondPath,
    "second.jpg",
    "image/jpeg",
    4,
    "same",
    null,
    null,
    null,
    { important: true },
    "2025-09-17T11:00:00.000Z",
    { name: "records", path: path.join(directory, "media") },
    "duplicate",
    { contentFingerprint: "same-fingerprint" }
  )
  db.prepare("UPDATE attachments SET content_fingerprint = ? WHERE id = ?").run(
    "same-fingerprint",
    imageA.attachment.id
  )
  assert.equal((await call("days:list-with-content")).length, 2)
  assert.equal((await call("days:get", ["2025-09-17"])).date, "2025-09-17")
  assert.equal(
    (await call("days:list-for-range", ["2025-01-01", "2025-12-31"])).length,
    1
  )
  assert.equal((await call("days:list-for-year", [2025])).length, 1)
  assert.deepEqual(await call("days:memory", [null]), [])
  assert.ok((await call("days:memory", ["2026-09-17"])).length > 0)
  assert.deepEqual(await call("days:story-items", [null]), [])
  assert.ok((await call("days:story-items", ["2026-09-17"])).length > 0)
  assert.deepEqual(await call("settings:set", ["week_start_day", "sunday"]), {
    key: "week_start_day",
    value: "sunday"
  })
  assert.equal((await call("settings:all")).week_start_day, "sunday")
  const mediaFolders = await call("media-folders:list")
  assert.equal(mediaFolders.length, 1)
  assert.equal(mediaFolders[0].indexedCount, 2)
  assert.equal((await call("system:capabilities")).mediaFolders, true)

  for (const [method, args] of [
    ["attachments:get", [imageA.attachment.id]],
    ["attachments:list", ["2026-09-03"]],
    ["attachments:list-all", []],
    ["attachments:list-for-range", ["2025-01-01", "2026-12-31"]],
    ["attachments:list-geo", []],
    ["attachments:list-missing-date-time-original", []],
    ["attachments:list-no-gps", []],
    ["messages:list-folder-items", ["visible"]],
    ["messages:list-folders", []]
  ]) {
    await call(method, args)
  }
  assert.equal((await call("thumbnails:warmup")).done, 2)
  assert.equal((await call("thumbnails:warmup-micro")).done, 2)
  assert.equal((await call("thumbnails:regenerate-all")).done, 2)
  assert.deepEqual(
    await call("thumbnails:regenerate", [imageA.attachment.id]),
    {
      ok: false,
      reason: "generation-failed"
    }
  )

  const groups = await call("attachments:list-duplicate-groups")
  assert.equal(groups.length, 1)
  await call("attachments:set-duplicate-canonical", [
    "same-fingerprint",
    imageA.attachment.id
  ])

  await assert.rejects(call(null), /Invalid RPC request/)
  await assert.rejects(
    call("attachments:write-gps-to-file", [imageA.attachment.id, 91, 0])
  )
})
