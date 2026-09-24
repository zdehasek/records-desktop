import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const modulePath = "../../runtime/src/services/video-stream.js"

function fixture(context) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-video-stream-")
  )
  const source = path.join(directory, "source.mkv")
  const calls = path.join(directory, "calls.jsonl")
  const ffprobe = path.join(directory, "ffprobe")
  const ffmpeg = path.join(directory, "ffmpeg")
  const previous = {
    REC_FFMPEG_PATH: process.env.REC_FFMPEG_PATH,
    REC_FFPROBE_PATH: process.env.REC_FFPROBE_PATH,
    FAKE_FFMPEG_CALLS: process.env.FAKE_FFMPEG_CALLS,
    FAKE_FFMPEG_DELAY: process.env.FAKE_FFMPEG_DELAY,
    FAKE_FFMPEG_FAIL_COPY: process.env.FAKE_FFMPEG_FAIL_COPY,
    FAKE_FFPROBE_RAW: process.env.FAKE_FFPROBE_RAW,
    FAKE_FFPROBE_STREAMS: process.env.FAKE_FFPROBE_STREAMS
  }

  fs.writeFileSync(source, "video fixture")
  fs.writeFileSync(
    ffprobe,
    `#!/usr/bin/env node
process.stdout.write(process.env.FAKE_FFPROBE_RAW || JSON.stringify({ streams: JSON.parse(process.env.FAKE_FFPROBE_STREAMS || "[]") }))
`
  )
  fs.writeFileSync(
    ffmpeg,
    `#!/usr/bin/env node
const fs = require("node:fs")
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_FFMPEG_CALLS, JSON.stringify(args) + "\\n")
if (args.includes("-encoders")) {
  process.stdout.write(" V..... libx264 fake encoder\\n V..... libopenh264 fake encoder\\n")
  process.exit(0)
}
if (process.env.FAKE_FFMPEG_FAIL_COPY === "1" && args.includes("copy")) {
  process.stderr.write("copy failed")
  process.exit(1)
}
setTimeout(() => fs.writeFileSync(args.at(-1), "converted video"), Number(process.env.FAKE_FFMPEG_DELAY || 0))
`
  )
  fs.chmodSync(ffprobe, 0o700)
  fs.chmodSync(ffmpeg, 0o700)
  process.env.REC_FFMPEG_PATH = ffmpeg
  process.env.REC_FFPROBE_PATH = ffprobe
  process.env.FAKE_FFMPEG_CALLS = calls

  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return { directory, source, calls }
}

function readCalls(file) {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test("passes through non-video files and rejects missing videos", async (context) => {
  const { directory } = fixture(context)
  const { ensureStreamableVideo } = await import(`${modulePath}?basic`)
  const absent = path.join(directory, "absent.mp4")

  assert.deepEqual(
    await ensureStreamableVideo({
      attachmentId: 1,
      filePath: absent,
      mimeType: "image/jpeg",
      dataDir: directory
    }),
    { filePath: absent, mimeType: "image/jpeg", converted: false }
  )
  await assert.rejects(
    ensureStreamableVideo({
      attachmentId: 2,
      filePath: absent,
      mimeType: "video/mp4",
      dataDir: directory
    }),
    /Video file missing/
  )
})

test("remuxes H.264 video, reuses its cache, and removes stale cache files", async (context) => {
  const { directory, source, calls } = fixture(context)
  process.env.FAKE_FFPROBE_STREAMS = JSON.stringify([
    { codec_type: "video", codec_name: "h264" },
    { codec_type: "audio", codec_name: "aac" }
  ])
  const { mediaCacheKey } =
    await import("../../runtime/src/services/media-cache-key.js")
  const { ensureStreamableVideo } = await import(`${modulePath}?remux`)
  const cacheDir = path.join(directory, "streamable-video")
  fs.mkdirSync(cacheDir)
  const stale = path.join(
    cacheDir,
    `${mediaCacheKey({ filePath: source }).sourceId}-stale.mp4`
  )
  fs.writeFileSync(stale, "old")
  const options = {
    attachmentId: 7,
    filePath: source,
    mimeType: "video/x-matroska",
    dataDir: directory
  }

  const first = await ensureStreamableVideo(options)
  assert.equal(first.converted, true)
  assert.equal(first.mimeType, "video/mp4")
  assert.equal(fs.readFileSync(first.filePath, "utf8"), "converted video")
  assert.equal(fs.statSync(first.filePath).mode & 0o777, 0o600)
  assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700)
  assert.equal(fs.existsSync(stale), false)
  assert.ok(readCalls(calls).some((args) => args.includes("copy")))

  const callCount = readCalls(calls).length
  assert.deepEqual(await ensureStreamableVideo(options), first)
  assert.equal(readCalls(calls).length, callCount)
})

test("deduplicates concurrent work and falls back from remux to transcoding", async (context) => {
  const { directory, source, calls } = fixture(context)
  process.env.FAKE_FFMPEG_FAIL_COPY = "1"
  process.env.FAKE_FFPROBE_STREAMS = JSON.stringify([
    { codec_type: "video", codec_name: "h264" },
    { codec_type: "audio", codec_name: "mp3" }
  ])
  const { ensureStreamableVideo } = await import(`${modulePath}?fallback`)
  const options = {
    attachmentId: 8,
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory,
    force: true
  }

  const [first, second] = await Promise.all([
    ensureStreamableVideo(options),
    ensureStreamableVideo(options)
  ])
  assert.deepEqual(second, first)
  const invocations = readCalls(calls)
  assert.equal(invocations.filter((args) => args.includes("copy")).length, 1)
  assert.equal(
    invocations.filter((args) => args.includes("-encoders")).length,
    1
  )
  assert.ok(
    invocations.some(
      (args) => args.includes("libx264") && args.includes("yuv420p")
    )
  )
})

test("stream cache ignores reused IDs and separates equal-stat paths", async (context) => {
  const { directory, source, calls } = fixture(context)
  const other = path.join(directory, "other.mkv")
  fs.copyFileSync(source, other)
  const timestamp = new Date(1_700_000_000_000)
  fs.utimesSync(source, timestamp, timestamp)
  fs.utimesSync(other, timestamp, timestamp)
  process.env.FAKE_FFPROBE_STREAMS = JSON.stringify([
    { codec_type: "video", codec_name: "h264" }
  ])
  const { ensureStreamableVideo } = await import(
    `${modulePath}?source-identity`
  )

  const first = await ensureStreamableVideo({
    attachmentId: 4,
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory
  })
  const second = await ensureStreamableVideo({
    attachmentId: 4,
    filePath: other,
    mimeType: "video/mp4",
    dataDir: directory
  })
  assert.notEqual(first.filePath, second.filePath)
  assert.equal(
    readCalls(calls).filter((args) => args.includes("copy")).length,
    2
  )

  const reused = await ensureStreamableVideo({
    attachmentId: 999,
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory
  })
  assert.equal(reused.filePath, first.filePath)
  assert.equal(
    readCalls(calls).filter((args) => args.includes("copy")).length,
    2
  )
})

test("stream cache detects replacement and prunes the old revision", async (context) => {
  const { directory, source } = fixture(context)
  process.env.FAKE_FFPROBE_STREAMS = JSON.stringify([
    { codec_type: "video", codec_name: "h264" }
  ])
  const { ensureStreamableVideo } = await import(`${modulePath}?replacement`)
  const options = {
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory
  }
  const first = await ensureStreamableVideo(options)
  const original = fs.statSync(source)
  const replacement = path.join(directory, "replacement.mkv")
  fs.writeFileSync(replacement, "other fixture")
  fs.utimesSync(replacement, original.atime, original.mtime)
  fs.renameSync(replacement, source)

  const second = await ensureStreamableVideo(options)
  assert.notEqual(first.filePath, second.filePath)
  assert.equal(fs.existsSync(first.filePath), false)
  assert.equal(fs.existsSync(second.filePath), true)
})

test("source prune and full clear cannot be undone by in-flight work", async (context) => {
  const { calls, directory, source } = fixture(context)
  process.env.FAKE_FFPROBE_STREAMS = JSON.stringify([
    { codec_type: "video", codec_name: "h264" }
  ])
  const { clearStreamableVideos, ensureStreamableVideo, pruneStreamableVideo } =
    await import(`${modulePath}?clear-prune`)
  const options = {
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory
  }
  const generated = await ensureStreamableVideo(options)
  await pruneStreamableVideo(directory, { filePath: source })
  assert.equal(fs.existsSync(generated.filePath), false)

  process.env.FAKE_FFMPEG_DELAY = "100"
  const priorCallCount = readCalls(calls).length
  const pendingVideo = ensureStreamableVideo({ ...options, force: true })
  const pendingRejection = assert.rejects(pendingVideo)
  while (readCalls(calls).length === priorCallCount) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await clearStreamableVideos(directory)
  process.env.FAKE_FFMPEG_DELAY = "0"
  const currentVideo = await ensureStreamableVideo(options)
  await pendingRejection
  assert.equal(fs.existsSync(currentVideo.filePath), true)
  assert.deepEqual(fs.readdirSync(path.dirname(currentVideo.filePath)), [
    path.basename(currentVideo.filePath)
  ])
})

test("real stream generation retains decodable embedded audio", async (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-video-audio-integration-")
  )
  const source = path.join(directory, "tone.mp4")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  execFileSync("/usr/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=12:d=1",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=48000:duration=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    source
  ])

  const { ensureStreamableVideo } = await import(`${modulePath}?real-audio`)
  const result = await ensureStreamableVideo({
    filePath: source,
    mimeType: "video/mp4",
    dataDir: directory,
    force: true
  })
  const probe = JSON.parse(
    execFileSync(
      "/usr/bin/ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        result.filePath
      ],
      { encoding: "utf8" }
    )
  )
  assert.deepEqual(
    new Set(probe.streams.map((stream) => stream.codec_type)),
    new Set(["video", "audio"])
  )

  const pcm = execFileSync("/usr/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    result.filePath,
    "-map",
    "0:a:0",
    "-f",
    "s16le",
    "-acodec",
    "pcm_s16le",
    "pipe:1"
  ])
  assert.ok(pcm.length > 0)
  assert.ok(
    Array.from({ length: Math.floor(pcm.length / 2) }, (_, index) =>
      pcm.readInt16LE(index * 2)
    ).some((sample) => sample !== 0)
  )
})
