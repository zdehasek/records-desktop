import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

function executable(filePath, body) {
  fs.writeFileSync(filePath, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 })
}

test("media metadata reads video tags and image EXIF/GPS", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-metadata-"))
  const binDirectory = path.join(directory, "bin")
  fs.mkdirSync(binDirectory)
  executable(
    path.join(binDirectory, "ffprobe"),
    `const mode = process.env.FFPROBE_MODE
    if (mode === "failed") process.exit(1)
    if (mode === "invalid-json") return process.stdout.write("{")
    if (mode === "null") return process.stdout.write("null")
    if (mode === "null-stream") return process.stdout.write(JSON.stringify({ streams: [null] }))
    const data = mode === "audio-only"
      ? { format: { duration: "3.5" }, streams: [{ codec_type: "audio" }] }
      : mode === "silent"
        ? { format: {}, streams: [{ codec_type: "video", duration: "9", tags: { creation_time: "2023-01-02T03:04:05.000Z" } }] }
        : mode === "apple"
          ? { format: { duration: "4", tags: { creation_time: "2026-09-18T16:53:14.000000Z", "com.apple.quicktime.creationdate": "2026-09-16T10:36:12+0200", "com.apple.quicktime.location.ISO6709": "+50.9098+015.3225+601.461/", "com.apple.quicktime.make": "Apple", "com.apple.quicktime.model": "iPhone 14" } }, streams: [{ codec_type: "video" }] }
        : { format: { duration: "2.375", tags: { creation_time: "2024-01-02T03:04:05.000Z" } }, streams: [{ codec_type: "video", duration: "9" }, { codec_type: "audio", duration: "2.3" }] }
    process.stdout.write(JSON.stringify(data))`
  )
  executable(
    path.join(binDirectory, "magick"),
    `const values = process.env.MAGICK_MODE === "bad"
      ? ["bad", "", "", "invalid", "N", "invalid", "E"]
      : process.env.MAGICK_MODE === "zero-date"
        ? ["0000:00:00 00:00:00", "", "", "", "", "", ""]
        : ["2024:02:03 04:05:06", " Canon ", " Camera ", "50/1 30/1 0/1", "S", "14/1 15/1 0/1", "W"]
    process.stdout.write(values.join("\\u001f"))`
  )
  const previousPath = process.env.PATH
  process.env.PATH = `${binDirectory}:${previousPath}`
  context.after(() => {
    process.env.PATH = previousPath
    delete process.env.MAGICK_MODE
    delete process.env.FFPROBE_MODE
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const {
    projectMessageMetadata,
    readMediaMetadata,
    resolveMediaCreatedAt,
    resolveMediaMimeType
  } = await import(`../../runtime/media-metadata.js?test=${Date.now()}`)
  assert.equal(resolveMediaMimeType("video/mp4"), "video/mp4")
  assert.equal(
    resolveMediaMimeType("application/octet-stream", { mediaType: "video" }),
    "video/octet-stream"
  )
  assert.equal(
    resolveMediaMimeType("unknown", { mediaType: "video" }),
    "unknown"
  )
  assert.equal(
    resolveMediaCreatedAt({ createdAt: "metadata" }, "fallback", "override"),
    "override"
  )
  assert.equal(
    resolveMediaCreatedAt({ createdAt: null }, "fallback"),
    "fallback"
  )
  assert.deepEqual(projectMessageMetadata({ durationSeconds: Number.NaN }), {})
  assert.deepEqual(
    projectMessageMetadata(
      { durationSeconds: 2 },
      { important: true, noteColor: "mint" }
    ),
    {
      duration_seconds: 2,
      important: true,
      note_style: { color: "mint" }
    }
  )
  assert.deepEqual(await readMediaMetadata(path.join(directory, "video.mp4")), {
    exifData: { DateTimeOriginal: "2024-01-02T03:04:05.000Z" },
    createdAt: "2024-01-02T03:04:05.000Z",
    durationSeconds: 2.375,
    mediaType: "video",
    latitude: null,
    longitude: null
  })

  process.env.FFPROBE_MODE = "silent"
  const silentVideo = await readMediaMetadata(
    path.join(directory, "silent.webm")
  )
  assert.equal(silentVideo.createdAt, "2023-01-02T03:04:05.000Z")
  assert.equal(silentVideo.durationSeconds, 9)
  assert.equal(silentVideo.mediaType, "video")

  process.env.FFPROBE_MODE = "apple"
  const appleVideo = await readMediaMetadata(
    path.join(directory, "apple-video.mov")
  )
  assert.equal(appleVideo.createdAt, "2026-09-16T08:36:12.000Z")
  assert.equal(appleVideo.exifData.DateTimeOriginal, appleVideo.createdAt)
  assert.equal(appleVideo.exifData.Make, "Apple")
  assert.equal(appleVideo.exifData.Model, "iPhone 14")
  assert.equal(appleVideo.latitude, 50.9098)
  assert.equal(appleVideo.longitude, 15.3225)

  process.env.FFPROBE_MODE = "audio-only"
  await assert.rejects(
    readMediaMetadata(path.join(directory, "audio-only.webm")),
    /does not contain a video stream/
  )
  process.env.FFPROBE_MODE = "failed"
  await assert.rejects(
    readMediaMetadata(path.join(directory, "unreadable.webm")),
    /could not be verified as video/
  )
  for (const mode of ["invalid-json", "null", "null-stream"]) {
    process.env.FFPROBE_MODE = mode
    await assert.rejects(
      readMediaMetadata(path.join(directory, `${mode}.webm`)),
      (error) => error.code === "UNSUPPORTED_MEDIA" && error.retryable === true
    )
  }
  process.env.FFPROBE_MODE = "default"

  const image = await readMediaMetadata(path.join(directory, "photo.jpg"))
  assert.equal(image.createdAt, "2024-02-03T04:05:06")
  assert.equal(image.exifData.Make, "Canon")
  assert.equal(image.exifData.Model, "Camera")
  assert.equal(image.latitude, -50.5)
  assert.equal(image.longitude, -14.25)

  const offsetImage = await readMediaMetadata(
    path.join(directory, "photo.jpg"),
    {
      captionMetadata: {
        read: async () => ({
          caption: "Offset photo",
          conflict: false,
          values: {},
          dateTimeOriginal: "2026:09:17 00:30:00",
          offsetTimeOriginal: "+14:00",
          createdAt: "2026-09-17T00:30:00+14:00",
          important: true,
          presentationColor: "sky"
        })
      }
    }
  )
  assert.equal(offsetImage.createdAt, "2026-09-17T00:30:00+14:00")
  assert.equal(offsetImage.exifData.OffsetTimeOriginal, "+14:00")
  await assert.rejects(
    readMediaMetadata(path.join(directory, "photo.jpg"), {
      captionMetadata: {
        read: async () => Promise.reject(new Error("exif failed"))
      }
    }),
    /exif failed/
  )

  process.env.MAGICK_MODE = "bad"
  const malformed = await readMediaMetadata(path.join(directory, "bad.jpg"))
  assert.equal(malformed.createdAt, null)
  assert.equal(malformed.latitude, null)
  assert.equal(malformed.longitude, null)
  assert.deepEqual(malformed.exifData, { DateTimeOriginal: "bad" })

  process.env.MAGICK_MODE = "zero-date"
  const zeroDate = await readMediaMetadata(path.join(directory, "zero.jpg"))
  assert.equal(zeroDate.createdAt, null)
})

test("media metadata rejects missing required extractors", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-no-tools-"))
  const previousPath = process.env.PATH
  process.env.PATH = directory
  context.after(() => {
    process.env.PATH = previousPath
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const { readMediaMetadata } = await import(
    `../../runtime/media-metadata.js?missing=${Date.now()}`
  )
  await assert.rejects(
    readMediaMetadata(path.join(directory, "video.webm")),
    /FFprobe is required/
  )
  await assert.rejects(
    readMediaMetadata(path.join(directory, "photo.jpg")),
    /ImageMagick is required/
  )
})
