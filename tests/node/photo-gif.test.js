import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { openDatabase } from "../../runtime/database.js"
import * as days from "../../runtime/src/repositories/days.js"
import * as messages from "../../runtime/src/repositories/messages.js"
import { createPhotoGif } from "../../runtime/src/services/photo-gif.js"

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-gif-test-"))
  const rootPath = path.join(directory, "media")
  fs.mkdirSync(rootPath)
  const db = openDatabase(path.join(directory, "cache.sqlite3"))
  const root = {
    name: "records",
    path: rootPath,
    enabled: true
  }
  const config = {
    defaultMediaRoot: () => root,
    mediaRoots: () => [root]
  }
  context.after(() => {
    db.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { db, root, config }
}

test("standalone GIF preserves selection order, capture date, and filenames", async (context) => {
  const { db, root, config } = fixture(context)
  const day = days.ensure(db, "2026-09-03")
  const selected = ["Second Photo.jpg", "First Photo.jpg"].map(
    (fileName, index) => {
      const filePath = path.join(root.path, fileName)
      fs.writeFileSync(filePath, `image-${index}`)
      return messages.addPhoto(
        db,
        day.id,
        filePath,
        fileName,
        "image/jpeg",
        7,
        `sum-${index}`,
        null,
        null,
        null,
        null,
        `2026-09-03T0${index + 8}:00:00.000Z`,
        root
      )
    }
  )
  const outputDirectory = path.join(root.path, "records", "2026", "09", "03")
  fs.mkdirSync(outputDirectory, { recursive: true })
  fs.writeFileSync(
    path.join(outputDirectory, "Second-Photo-animation.gif"),
    "existing"
  )
  const calls = []
  const result = await createPhotoGif(
    db,
    selected.map((item) => item.message.id),
    {
      config,
      ffmpeg: "/fake/ffmpeg",
      execFile: async (command, args) => {
        calls.push({ command, args })
        fs.writeFileSync(args.at(-1), "gif")
      },
      captionMetadata: {
        capabilities: () => ({ write: true }),
        write: async (filePath, patch) => {
          assert.equal(patch.createdAt, "2026-09-03T08:00:00.000Z")
          assert.equal(fs.existsSync(filePath), true)
        }
      }
    }
  )
  assert.equal(result.fileName, "Second-Photo-animation-2.gif")
  assert.equal(result.path, "records/2026/09/03/Second-Photo-animation-2.gif")
  assert.equal(fs.existsSync(result.filePath), true)
  assert.equal(calls[0].command, "/fake/ffmpeg")
  const inputs = calls[0].args
    .map((value, index, values) => (values[index - 1] === "-i" ? value : null))
    .filter(Boolean)
  assert.deepEqual(
    inputs,
    selected.map((item) => item.attachment.file_path)
  )
})

test("standalone GIF rejects invalid selections", async (context) => {
  const { db, config } = fixture(context)
  await assert.rejects(createPhotoGif(db, [], { config }), /at least 2/)
  await assert.rejects(
    createPhotoGif(db, [1, 2], {
      config,
      captionMetadata: { capabilities: () => ({ write: false }) }
    }),
    /metadata tools/
  )
})

test("standalone GIF leaves no output when metadata writing fails", async (context) => {
  const { db, root, config } = fixture(context)
  const day = days.ensure(db, "2026-09-03")
  const selected = ["one.jpg", "two.jpg"].map((fileName, index) => {
    const filePath = path.join(root.path, fileName)
    fs.writeFileSync(filePath, `image-${index}`)
    return messages.addPhoto(
      db,
      day.id,
      filePath,
      fileName,
      "image/jpeg",
      7,
      `failure-sum-${index}`,
      null,
      null,
      null,
      null,
      "2026-09-03T08:00:00.000Z",
      root
    )
  })

  await assert.rejects(
    createPhotoGif(
      db,
      selected.map((item) => item.message.id),
      {
        config,
        execFile: async (_command, args) => {
          fs.writeFileSync(args.at(-1), "gif")
        },
        captionMetadata: {
          capabilities: () => ({ write: true }),
          write: async () => {
            throw new Error("metadata failed")
          }
        }
      }
    ),
    /metadata failed/
  )

  assert.equal(fs.existsSync(path.join(root.path, "records")), false)
})
