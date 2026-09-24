import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { closeThumbnailDb } from "../../runtime/src/services/thumbnail/thumbnail-db.js"

const modulePath = "../../runtime/thumbnails.js"

function fixture(context) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-thumbnails-")
  )
  const bin = path.join(directory, "bin")
  const calls = path.join(directory, "calls.jsonl")
  const previousPath = process.env.PATH
  const previousCalls = process.env.FAKE_THUMBNAIL_CALLS
  const previousDelay = process.env.FAKE_THUMBNAIL_DELAY
  const previousFailure = process.env.FAKE_THUMBNAIL_FAIL
  const previousIgnoreTerm = process.env.FAKE_THUMBNAIL_IGNORE_TERM
  fs.mkdirSync(bin)
  const command = path.join(bin, "magick")
  fs.writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
if (process.env.FAKE_THUMBNAIL_IGNORE_TERM === "1") process.on("SIGTERM", () => {})
fs.appendFileSync(process.env.FAKE_THUMBNAIL_CALLS, JSON.stringify(args) + "\\n")
if (process.env.FAKE_THUMBNAIL_FAIL === "1") {
  process.stderr.write("thumbnail failed")
  process.exit(1)
}
const source = args[0].replace(/\\[0\\]$/, "")
setTimeout(() => fs.writeFileSync(args.at(-1), "thumb:" + fs.readFileSync(source, "utf8")), Number(process.env.FAKE_THUMBNAIL_DELAY || 0))
`
  )
  fs.chmodSync(command, 0o700)
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`
  process.env.FAKE_THUMBNAIL_CALLS = calls
  context.after(() => {
    closeThumbnailDb()
    process.env.PATH = previousPath
    if (previousCalls === undefined) delete process.env.FAKE_THUMBNAIL_CALLS
    else process.env.FAKE_THUMBNAIL_CALLS = previousCalls
    if (previousDelay === undefined) delete process.env.FAKE_THUMBNAIL_DELAY
    else process.env.FAKE_THUMBNAIL_DELAY = previousDelay
    if (previousFailure === undefined) delete process.env.FAKE_THUMBNAIL_FAIL
    else process.env.FAKE_THUMBNAIL_FAIL = previousFailure
    if (previousIgnoreTerm === undefined)
      delete process.env.FAKE_THUMBNAIL_IGNORE_TERM
    else process.env.FAKE_THUMBNAIL_IGNORE_TERM = previousIgnoreTerm
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, calls }
}

function attachment(filePath, id = 1) {
  return {
    id,
    root_name: "records",
    relative_path: path.basename(filePath),
    file_path: filePath,
    mime_type: "image/jpeg"
  }
}

function callCount(filePath) {
  if (!fs.existsSync(filePath)) return 0
  return fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean)
    .length
}

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for condition")
}

test("thumbnail cache ignores reused IDs and detects source replacement", async (context) => {
  const { directory, calls } = fixture(context)
  const firstPath = path.join(directory, "first.jpg")
  const secondPath = path.join(directory, "second.jpg")
  fs.writeFileSync(firstPath, "aaaa")
  fs.writeFileSync(secondPath, "bbbb")
  const timestamp = new Date(1_700_000_000_000)
  fs.utimesSync(firstPath, timestamp, timestamp)
  fs.utimesSync(secondPath, timestamp, timestamp)
  const { createThumbnailService } = await import(`${modulePath}?identity`)
  const service = createThumbnailService(path.join(directory, "cache"))

  assert.equal(
    (await service.generate(attachment(firstPath, 7), "thumb")).toString(),
    "thumb:aaaa"
  )
  assert.equal(
    (await service.generate(attachment(firstPath, 99), "thumb")).toString(),
    "thumb:aaaa"
  )
  assert.equal(callCount(calls), 1)
  assert.equal(
    (await service.generate(attachment(secondPath, 7), "thumb")).toString(),
    "thumb:bbbb"
  )
  assert.equal(callCount(calls), 2)

  const replacement = path.join(directory, "replacement.jpg")
  fs.writeFileSync(replacement, "cccc")
  fs.utimesSync(replacement, timestamp, timestamp)
  fs.renameSync(replacement, firstPath)
  assert.equal(
    (await service.generate(attachment(firstPath, 7), "thumb")).toString(),
    "thumb:cccc"
  )
  assert.equal(callCount(calls), 3)
})

test("clear prevents an in-flight thumbnail from repopulating the cache", async (context) => {
  const { directory, calls } = fixture(context)
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  process.env.FAKE_THUMBNAIL_DELAY = "100"
  const { createThumbnailService } = await import(`${modulePath}?clear-race`)
  const service = createThumbnailService(path.join(directory, "cache"))
  const item = attachment(source)

  assert.equal(service.invalidate(null), false)
  assert.equal(service.invalidate(1), false)
  assert.equal(service.invalidate(item), true)

  const pending = service.generate(item, "thumb")
  await new Promise((resolve) => setTimeout(resolve, 25))
  service.clear()
  assert.equal(await pending, null)
  process.env.FAKE_THUMBNAIL_DELAY = "0"
  assert.equal(
    (await service.generate(item, "thumb")).toString(),
    "thumb:source"
  )
  assert.equal(callCount(calls), 2)
})

test("thumbnail command failures clean temporary files", async (context) => {
  const { directory, calls } = fixture(context)
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  process.env.FAKE_THUMBNAIL_FAIL = "1"
  const { createThumbnailService } = await import(`${modulePath}?failure`)
  const service = createThumbnailService(path.join(directory, "cache"))

  await assert.rejects(
    service.generate(attachment(source), "thumb"),
    /thumbnail failed/
  )
  const [args] = fs
    .readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  const temporaryDirectory = path.dirname(args.at(-1))
  assert.match(path.basename(temporaryDirectory), /^records-thumb-/)
  assert.equal(fs.existsSync(temporaryDirectory), false)
})

test("thumbnail generation is bounded and queued work is abortable", async (context) => {
  const { directory, calls } = fixture(context)
  process.env.FAKE_THUMBNAIL_DELAY = "150"
  const { createThumbnailService } = await import(`${modulePath}?bounded`)
  const service = createThumbnailService(path.join(directory, "cache"), {
    maxConcurrent: 2
  })
  const items = Array.from({ length: 5 }, (_, index) => {
    const source = path.join(directory, `${index}.jpg`)
    fs.writeFileSync(source, String(index))
    return attachment(source, index + 1)
  })

  const first = service.generate(items[0], "thumb")
  const second = service.generate(items[1], "thumb")
  await waitFor(() => callCount(calls) === 2)

  const controller = new AbortController()
  const aborted = service.generate(items[2], "thumb", false, {
    signal: controller.signal
  })
  const later = [
    service.generate(items[3], "thumb"),
    service.generate(items[4], "thumb")
  ]
  controller.abort()
  await assert.rejects(aborted, { name: "AbortError", code: "ABORT_ERR" })
  assert.equal(callCount(calls), 2)

  await Promise.all([first, second, ...later])
  assert.equal(callCount(calls), 4)
})

test("a canceled active thumbnail does not poison a new request", async (context) => {
  const { directory, calls } = fixture(context)
  process.env.FAKE_THUMBNAIL_DELAY = "1000"
  process.env.FAKE_THUMBNAIL_IGNORE_TERM = "1"
  const { createThumbnailService } = await import(`${modulePath}?active-abort`)
  const service = createThumbnailService(path.join(directory, "cache"), {
    maxConcurrent: 1
  })
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  const item = attachment(source)
  const controller = new AbortController()

  const canceled = service.generate(item, "thumb", false, {
    signal: controller.signal
  })
  await waitFor(() => callCount(calls) === 1)
  process.env.FAKE_THUMBNAIL_DELAY = "0"
  controller.abort()
  await assert.rejects(canceled, { name: "AbortError", code: "ABORT_ERR" })

  assert.equal(
    (await service.generate(item, "thumb")).toString(),
    "thumb:source"
  )
  assert.equal(callCount(calls), 2)
})

test("canceling one thumbnail observer preserves shared work", async (context) => {
  const { directory, calls } = fixture(context)
  process.env.FAKE_THUMBNAIL_DELAY = "100"
  const { createThumbnailService } = await import(`${modulePath}?shared-abort`)
  const service = createThumbnailService(path.join(directory, "cache"))
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  const item = attachment(source)
  const firstController = new AbortController()
  const secondController = new AbortController()

  const first = service.generate(item, "thumb", false, {
    signal: firstController.signal
  })
  const second = service.generate(item, "thumb", false, {
    signal: secondController.signal
  })
  await waitFor(() => callCount(calls) === 1)
  firstController.abort()

  await assert.rejects(first, { name: "AbortError", code: "ABORT_ERR" })
  assert.equal((await second).toString(), "thumb:source")
  assert.equal(callCount(calls), 1)
})

test("concurrent forced regeneration is coalesced", async (context) => {
  const { directory, calls } = fixture(context)
  process.env.FAKE_THUMBNAIL_DELAY = "100"
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  const { createThumbnailService } = await import(`${modulePath}?regenerate`)
  const service = createThumbnailService(path.join(directory, "cache"))
  const item = attachment(source)

  const first = service.regenerate(item, "year")
  const second = service.regenerate(item, "year")
  assert.equal(first, second)
  await Promise.all([first, second])
  assert.equal(callCount(calls), 1)
})

test("forced regeneration keeps thumbnail variants independent", async (context) => {
  const { directory, calls } = fixture(context)
  process.env.FAKE_THUMBNAIL_DELAY = "100"
  const source = path.join(directory, "source.jpg")
  fs.writeFileSync(source, "source")
  const { createThumbnailService } = await import(`${modulePath}?variants`)
  const service = createThumbnailService(path.join(directory, "cache"))
  const item = attachment(source)

  const thumb = service.regenerate(item, "thumb")
  const year = service.regenerate(item, "year")
  assert.notEqual(thumb, year)
  await Promise.all([thumb, year])
  assert.equal(callCount(calls), 2)
  const invocations = fs
    .readFileSync(calls, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
  assert.ok(invocations.some((args) => args.includes("512x512>")))
  assert.ok(invocations.some((args) => args.includes("160x160>")))
})
