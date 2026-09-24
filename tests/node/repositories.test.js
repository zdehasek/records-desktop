import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { openDatabase } from "../../runtime/database.js"
import * as attachments from "../../runtime/src/repositories/attachments.js"
import * as days from "../../runtime/src/repositories/days.js"
import * as messages from "../../runtime/src/repositories/messages.js"

test("cache projections use named-root relative-path identity", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-repo-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const day = days.ensure(db, "2026-09-03")
  const root = { name: "records", path: directory }
  const filePath = path.join(directory, "one.jpg")
  fs.writeFileSync(filePath, "a")
  const inserted = messages.addPhoto(
    db,
    day.id,
    filePath,
    "one.jpg",
    "image/jpeg",
    1,
    "a",
    null,
    null,
    null,
    null,
    "2026-09-03T10:00:00Z",
    root
  )
  assert.throws(() => {
    fs.writeFileSync(filePath, "b")
    return messages.addPhoto(
      db,
      day.id,
      path.join(directory, "one.jpg"),
      "one.jpg",
      "image/jpeg",
      1,
      "b",
      null,
      null,
      null,
      null,
      "2026-09-03T11:00:00Z",
      root
    )
  }, /UNIQUE constraint failed/)
  const attachment = db
    .prepare("SELECT root_name, relative_path FROM attachments")
    .get()
  assert.deepEqual(
    { ...attachment },
    { root_name: "records", relative_path: "one.jpg" }
  )
  assert.equal(
    db.prepare("SELECT source_revision FROM attachments").get().source_revision,
    null
  )
  assert.equal(
    attachments.get(db, inserted.attachment.id, { mediaRoots: () => [root] })
      .file_path,
    filePath
  )
  db.prepare("UPDATE attachments SET source_revision = 'confirmed'").run()
  attachments.updateProjection(
    db,
    inserted.attachment.id,
    {
      content: "updated",
      important: false,
      noteColor: null,
      exifData: null,
      createdAt: "2026-09-03T10:00:00Z",
      byteSize: 1,
      mtimeMs: fs.statSync(filePath).mtimeMs
    },
    { mediaRoots: () => [root] }
  )
  assert.equal(
    db.prepare("SELECT source_revision FROM attachments").get().source_revision,
    null
  )
})

test("day featured media includes important videos", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-featured-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const day = days.ensure(db, "2026-09-03")
  const root = { name: "records", path: directory }
  const add = (name, mime, metadata, createdAt = "2026-09-03T10:00:00Z") => {
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, name)
    return messages.addPhoto(
      db,
      day.id,
      filePath,
      name,
      mime,
      Buffer.byteLength(name),
      name,
      null,
      null,
      null,
      metadata,
      createdAt,
      root
    )
  }
  const important = [
    add("important-a.jpg", "image/jpeg", { important: true }),
    add(
      "important-b.png",
      "image/png",
      { important: true },
      "2026-09-03T11:00:00Z"
    )
  ]
  const ordinary = add(
    "ordinary.jpg",
    "image/jpeg",
    null,
    "2026-09-03T09:00:00Z"
  )
  const video = add("important-video.mp4", "video/mp4", { important: true })
  const expected = new Set([
    ...important.map((item) => item.attachment.id),
    video.attachment.id
  ])

  const random = context.mock.method(Math, "random", () => 0)
  assert.equal(
    days.get(db, day.id).photo_attachment_id,
    important[0].attachment.id
  )
  assert.equal(
    days.listForRange(db, day.date, day.date)[0].photo_attachment_id,
    important[0].attachment.id
  )
  random.mock.mockImplementation(() => 0.999)
  assert.equal(
    days.get(db, day.id).photo_attachment_id,
    important[1].attachment.id
  )
  assert.equal(
    days.listForRange(db, day.date, day.date)[0].photo_attachment_id,
    important[1].attachment.id
  )
  random.mock.mockImplementation(() => 0.5)
  assert.equal(days.get(db, day.id).photo_attachment_id, video.attachment.id)
  assert.equal(
    days.listForRange(db, day.date, day.date)[0].photo_attachment_id,
    video.attachment.id
  )
  for (let index = 0; index < 5; index += 1) {
    assert.ok(expected.has(days.listWithContent(db)[0].photo_attachment_id))
  }

  db.prepare(
    "UPDATE attachments SET important = 0 WHERE mime_type LIKE 'image/%'"
  ).run()
  assert.equal(days.get(db, day.id).photo_attachment_id, video.attachment.id)
  assert.equal(
    days.listForRange(db, day.date, day.date)[0].photo_attachment_id,
    video.attachment.id
  )
  db.prepare("UPDATE attachments SET important = 0 WHERE id = ?").run(
    video.attachment.id
  )
  assert.equal(days.get(db, day.id).photo_attachment_id, null)
  assert.equal(
    days.get(db, day.id, { autoPhoto: true }).photo_attachment_id,
    ordinary.attachment.id
  )
  assert.equal(
    days.listForRange(db, day.date, day.date, { autoPhoto: true })[0]
      .photo_attachment_id,
    ordinary.attachment.id
  )
})

test("memory stories use an automatic photo as the playable cover", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-story-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const root = { name: "records", path: directory }
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const add = (name, mime, important = false, date = "2026-08-18") => {
    const filePath = path.join(directory, name)
    fs.writeFileSync(filePath, name)
    return messages.addPhoto(
      db,
      date,
      filePath,
      name,
      mime,
      Buffer.byteLength(name),
      name,
      null,
      null,
      null,
      important ? { important: true } : null,
      `${date}T10:00:0${important ? 1 : 0}Z`,
      root
    )
  }
  const photo = add("ordinary.jpg", "image/jpeg")
  const video = add("important.mp4", "video/mp4", true)
  const config = { mediaRoots: () => [root] }

  assert.deepEqual(days.memory(db, "2026-09-18", { autoPhoto: true }), [
    {
      id: "2026-08-18",
      date: "2026-08-18",
      created_at: "2026-08-18T00:00:00.000Z",
      updated_at: "2026-08-18T00:00:00.000Z",
      photo_attachment_id: video.attachment.id,
      photo_count: 2,
      label: "1M",
      period: "1m"
    }
  ])

  assert.deepEqual(days.storyItems(db, "2026-09-18", {}, config), [
    {
      day: { id: "2026-08-18", date: "2026-08-18", label: "1M", period: "1m" },
      message: messages.get(db, video.message.id),
      attachment: attachments.get(db, video.attachment.id, config),
      isCover: false,
      isImportant: true
    }
  ])
  const story = days.storyItems(db, "2026-09-18", { autoPhoto: true }, config)
  assert.equal(story.length, 2)
  assert.equal(story[0].attachment.id, photo.attachment.id)
  assert.equal(story[0].isCover, true)
  assert.equal(story[0].isImportant, false)
  assert.equal(story[1].attachment.id, video.attachment.id)
  assert.equal(story[1].isImportant, true)

  db.prepare(
    `INSERT INTO attachments
      (root_name, relative_path, mime_type, byte_size, mtime_ms, created_at)
     VALUES ('records', 'invalid-zero.jpg', 'image/jpeg', 0, 0,
              '0000-00-00T00:00:00'),
            ('records', 'invalid-calendar.jpg', 'image/jpeg', 0, 0,
              '2025-99-99T00:00:00Z')`
  ).run()
  assert.equal(
    days.listWithContent(db).some((item) => item.date === "0000-00-00"),
    false
  )
  assert.equal(days.memory(db, "2026-09-18", { autoPhoto: true }).length, 1)
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM attachments
        WHERE created_at >= ? AND created_at < ? ORDER BY created_at`
    )
    .all("2026-08-18", "2026-08-19")
    .map((row) => row.detail)
    .join(" ")
  assert.match(plan, /idx_attachments_created/)

  const oldest = add("old-important.jpg", "image/jpeg", true, "2025-09-18")
  const orderedStory = days.storyItems(
    db,
    "2026-09-18",
    { autoPhoto: true },
    config
  )
  assert.equal(orderedStory[0].attachment.id, oldest.attachment.id)
  assert.deepEqual(
    [...new Set(orderedStory.map((item) => item.day.date))],
    ["2025-09-18", "2026-08-18"]
  )
})

test("day summaries apply visibility before choosing automatic photos", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-days-vis-"))
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const root = { name: "records", path: directory }
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const add = (relativePath) => {
    const filePath = path.join(directory, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, relativePath)
    return messages.addPhoto(
      db,
      "2026-09-03",
      filePath,
      path.basename(filePath),
      "image/jpeg",
      Buffer.byteLength(relativePath),
      relativePath,
      null,
      null,
      null,
      null,
      "2026-09-03T10:00:00Z",
      root
    ).attachment.id
  }
  const visible = add("visible.jpg")
  const nsfw = add(".nsfw/private/nsfw.jpg")
  const hidden = add(".hidden/private/hidden.jpg")
  const summary = (opts) =>
    days.listWithContent(db, { ...opts, autoPhoto: true })[0]

  assert.deepEqual(
    {
      count: summary({ nsfwMode: "hidden" }).photo_count,
      photo: summary({ nsfwMode: "hidden" }).photo_attachment_id
    },
    { count: 1, photo: visible }
  )
  assert.deepEqual(
    {
      count: summary({ nsfwMode: "blurred" }).photo_count,
      photo: summary({ nsfwMode: "blurred" }).photo_attachment_id
    },
    { count: 2, photo: Math.min(visible, nsfw) }
  )
  assert.deepEqual(
    {
      count: summary({ nsfwMode: "hidden", dotFilesVisible: true }).photo_count,
      photo: summary({ nsfwMode: "hidden", dotFilesVisible: true })
        .photo_attachment_id
    },
    { count: 2, photo: Math.min(visible, hidden) }
  )
})

test("addPhoto rejects escaped, non-regular, and mismatched sources", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-repo-source-")
  )
  const rootPath = path.join(directory, "media")
  fs.mkdirSync(rootPath)
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const root = { name: "records", path: rootPath }
  const outside = path.join(directory, "outside.jpg")
  const inside = path.join(rootPath, "inside.jpg")
  fs.writeFileSync(outside, "outside")
  fs.writeFileSync(inside, "inside")
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const add = (filePath, byteSize, mediaRoot = root) =>
    messages.addPhoto(
      db,
      1,
      filePath,
      path.basename(filePath),
      "image/jpeg",
      byteSize,
      "checksum",
      null,
      null,
      null,
      null,
      "2026-09-03T10:00:00Z",
      mediaRoot
    )

  assert.throws(() => add(outside, 7), /inside its media root/)
  assert.throws(() => add(rootPath, 0), /regular file/)
  assert.throws(() => add(inside, 1), /byte size does not match/)
  assert.throws(
    () =>
      messages.addPhoto(
        db,
        1,
        inside,
        "inside.jpg",
        "image/",
        6,
        "checksum",
        null,
        null,
        null,
        null,
        "2026-09-03T10:00:00Z",
        root
      ),
    /Invalid attachment projection/
  )
  assert.throws(
    () =>
      messages.addPhoto(
        db,
        1,
        inside,
        "inside.jpg",
        "image/jpeg",
        6,
        "checksum",
        null,
        50,
        null,
        null,
        "2026-09-03T10:00:00Z",
        root
      ),
    /provided together/
  )
  assert.throws(
    () =>
      messages.addPhoto(
        db,
        1,
        inside,
        "inside.jpg",
        "image/jpeg",
        6,
        "checksum",
        null,
        null,
        null,
        { important: "yes" },
        "2026-09-03T10:00:00Z",
        root
      ),
    /Invalid media importance/
  )
  assert.throws(
    () =>
      messages.addPhoto(
        db,
        1,
        inside,
        "inside.jpg",
        "image/jpeg",
        6,
        "checksum",
        null,
        null,
        null,
        null,
        "September 3 2026",
        root
      ),
    /Invalid created_at/
  )
  assert.throws(
    () => add(inside, 6, { name: "Bad Root", path: rootPath }),
    /root name/
  )
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    0
  )
})
