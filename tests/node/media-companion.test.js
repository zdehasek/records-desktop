import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  companionPath,
  parseMediaCompanion,
  readMediaCompanion,
  writeMediaCompanion
} from "../../runtime/src/services/media-companion.js"

test("media companions use nested note color and preserve unrelated YAML", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-companion-"))
  const mediaPath = path.join(directory, "interview.webm")
  fs.writeFileSync(mediaPath, "media")
  fs.writeFileSync(
    companionPath(mediaPath),
    "---\n# retained comment\ncustom: retained\nnote_style:\n  font: caveat\n---\n\nOld body\n"
  )
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  writeMediaCompanion(
    mediaPath,
    {
      date_override: "2026-09-03T10:11:12.000Z",
      important: true,
      note_style: { color: "butter" }
    },
    "Video caption"
  )

  const source = fs.readFileSync(companionPath(mediaPath), "utf8")
  assert.match(source, /# retained comment/)
  assert.match(source, /custom: retained/)
  assert.match(source, /note_style:\n {2}font: caveat\n {2}color: butter/)
  assert.deepEqual(readMediaCompanion(mediaPath).metadata, {
    date_override: "2026-09-03T10:11:12.000Z",
    important: true,
    note_style: { color: "butter" }
  })
})

test("media companions reject invalid note styles", () => {
  assert.throws(
    () => parseMediaCompanion("---\nnote_style: butter\n---\n"),
    /note_style must be a mapping/
  )
  assert.throws(
    () => parseMediaCompanion("---\nnote_style:\n  color: orange\n---\n"),
    /invalid note color/
  )
})

test("media companion writes distinguish unconditional writes from expected absence", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-companion-"))
  const mediaPath = path.join(directory, "clip.webm")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  writeMediaCompanion(mediaPath, {}, "first", { expectedRevision: null })
  writeMediaCompanion(mediaPath, {}, "unconditional")
  assert.equal(readMediaCompanion(mediaPath).content, "unconditional\n")

  assert.throws(
    () =>
      writeMediaCompanion(mediaPath, {}, "stale", { expectedRevision: null }),
    (error) => error.code === "MEDIA_COMPANION_CONFLICT"
  )
  assert.equal(readMediaCompanion(mediaPath).content, "unconditional\n")
})

test("media companion CAS preserves a concurrently changed companion", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-companion-"))
  const mediaPath = path.join(directory, "clip.webm")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const captured = writeMediaCompanion(mediaPath, {}, "captured")
  writeMediaCompanion(mediaPath, { important: true }, "authoritative")

  assert.throws(
    () =>
      writeMediaCompanion(mediaPath, {}, "stale", {
        expectedRevision: captured.revision
      }),
    (error) => error.code === "MEDIA_COMPANION_CONFLICT"
  )
  assert.equal(readMediaCompanion(mediaPath).content, "authoritative\n")
  assert.equal(readMediaCompanion(mediaPath).metadata.important, true)
})

test("media companion CAS conflicts when the captured companion was deleted", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-companion-"))
  const mediaPath = path.join(directory, "clip.webm")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const captured = writeMediaCompanion(mediaPath, {}, "captured")
  fs.rmSync(companionPath(mediaPath))

  assert.throws(
    () =>
      writeMediaCompanion(mediaPath, {}, "stale", {
        expectedRevision: captured.revision
      }),
    (error) => error.code === "MEDIA_COMPANION_CONFLICT"
  )
  assert.equal(fs.existsSync(companionPath(mediaPath)), false)
})

test("media companion returns only a parsed reread of the installed file", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-companion-"))
  const mediaPath = path.join(directory, "clip.webm")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(
    () =>
      writeMediaCompanion(mediaPath, {}, "projected only after readback", {
        atomicWrite: (filePath) =>
          fs.writeFileSync(filePath, "corrupt installed companion")
      }),
    /missing YAML frontmatter/
  )
  assert.equal(
    fs.readFileSync(companionPath(mediaPath), "utf8"),
    "corrupt installed companion"
  )

  const mismatchPath = path.join(directory, "mismatch.webm")
  const externalSource = "---\nimportant: true\n---\n\nexternal\n"
  assert.throws(
    () =>
      writeMediaCompanion(mismatchPath, {}, "requested", {
        atomicWrite: (filePath) => fs.writeFileSync(filePath, externalSource)
      }),
    /installed-file verification failed/
  )
  assert.equal(
    fs.readFileSync(companionPath(mismatchPath), "utf8"),
    externalSource
  )
})
