import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { openDatabase } from "../../runtime/database.js"
import * as messages from "../../runtime/src/repositories/messages.js"
import { reconcilePhotoCaptions } from "../../runtime/src/services/photo-caption-cache.js"

test("photo reconciliation refreshes authoritative caption, importance, and color", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-captions-"))
  const mediaPath = path.join(directory, "photo.jpg")
  const databasePath = path.join(directory, "index.sqlite3")
  fs.writeFileSync(mediaPath, "photo")
  const db = openDatabase(databasePath)
  const root = { name: "records", path: directory }
  const config = { mediaRoots: () => [root] }
  const inserted = messages.addPhoto(
    db,
    "2026-09-17",
    mediaPath,
    "photo.jpg",
    "image/jpeg",
    fs.statSync(mediaPath).size,
    null,
    { Description: "Old" },
    null,
    null,
    null,
    "2026-09-17T10:00:00.000Z",
    root,
    "Old"
  )
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const embedded = {
    caption: "Updated",
    conflict: false,
    important: true,
    presentationColor: "sky",
    values: { xmp: "Updated", iptc: "Updated", exif: "Updated" }
  }
  const captionMetadata = {
    capabilities: () => ({ read: true }),
    read: async () => embedded
  }
  db.prepare(
    "UPDATE attachments SET source_revision = 'confirmed' WHERE id = ?"
  ).run(inserted.message.id)

  assert.deepEqual(
    await reconcilePhotoCaptions(db, captionMetadata, { config }),
    { checked: 1, updated: 1, conflicts: 0, errors: [] }
  )
  assert.deepEqual(messages.get(db, inserted.message.id), {
    ...inserted.message,
    content: "Updated",
    metadata: { important: true, note_style: { color: "sky" } }
  })
  assert.equal(
    db
      .prepare("SELECT source_revision FROM attachments WHERE id = ?")
      .get(inserted.message.id).source_revision,
    null
  )
  assert.deepEqual(
    await reconcilePhotoCaptions(db, captionMetadata, { config }),
    { checked: 1, updated: 0, conflicts: 0, errors: [] }
  )

  embedded.conflict = true
  assert.deepEqual(
    await reconcilePhotoCaptions(db, captionMetadata, { config }),
    { checked: 1, updated: 0, conflicts: 1, errors: [] }
  )
})

test("photo reconciliation reports unavailable tools and per-file errors", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-captions-"))
  const mediaPath = path.join(directory, "photo.jpg")
  fs.writeFileSync(mediaPath, "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const root = { name: "records", path: directory }
  messages.addPhoto(
    db,
    "2026-09-17",
    mediaPath,
    "photo.jpg",
    "image/jpeg",
    fs.statSync(mediaPath).size,
    null,
    null,
    null,
    null,
    null,
    "2026-09-17T10:00:00.000Z",
    root
  )
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  assert.deepEqual(
    await reconcilePhotoCaptions(db, { capabilities: () => ({ read: false }) }),
    { checked: 0, updated: 0, conflicts: 0, errors: [] }
  )
  const failed = await reconcilePhotoCaptions(
    db,
    {
      capabilities: () => ({ read: true }),
      read: async () => {
        throw new Error("metadata unavailable")
      }
    },
    { config: { mediaRoots: () => [root] } }
  )
  assert.equal(failed.checked, 1)
  assert.equal(failed.updated, 0)
  assert.equal(failed.conflicts, 0)
  assert.match(failed.errors[0].error, /metadata unavailable/)
})

test("photo reconciliation keeps valid metadata when color is unsupported", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-captions-"))
  const mediaPath = path.join(directory, "photo.jpg")
  fs.writeFileSync(mediaPath, "photo")
  const db = openDatabase(path.join(directory, "index.sqlite3"))
  const root = { name: "records", path: directory }
  messages.addPhoto(
    db,
    "2026-09-17",
    mediaPath,
    "photo.jpg",
    "image/jpeg",
    fs.statSync(mediaPath).size,
    null,
    { Description: "Old" },
    null,
    null,
    null,
    "2026-09-17T10:00:00.000Z",
    root,
    "Old"
  )
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const result = await reconcilePhotoCaptions(
    db,
    {
      capabilities: () => ({ read: true }),
      read: async () => ({
        caption: "Valid caption",
        conflict: false,
        important: true,
        presentationColor: "chartreuse",
        values: {
          xmp: "Valid caption",
          iptc: "Valid caption",
          exif: "Valid caption"
        }
      })
    },
    { config: { mediaRoots: () => [root] } }
  )

  assert.deepEqual(result, {
    checked: 1,
    updated: 1,
    conflicts: 0,
    errors: []
  })
  const row = db
    .prepare(
      "SELECT content, important, note_color, exif_data FROM attachments"
    )
    .get()
  assert.equal(row.content, "Valid caption")
  assert.equal(row.important, 1)
  assert.equal(row.note_color, null)
  assert.equal(JSON.parse(row.exif_data).Description, "Valid caption")
})
