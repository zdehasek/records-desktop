import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const modulePath = "../../runtime/src/services/ffmpeg-binaries.js"

function fixture(context) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-ffmpeg-path-")
  )
  const previous = {
    PATH: process.env.PATH,
    REC_FFMPEG_DIR: process.env.REC_FFMPEG_DIR,
    REC_FFMPEG_PATH: process.env.REC_FFMPEG_PATH,
    REC_FFPROBE_PATH: process.env.REC_FFPROBE_PATH
  }
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return directory
}

test("prefers explicit binary paths and supports a shared binary directory", async (context) => {
  const directory = fixture(context)
  const explicit = path.join(directory, "custom-ffmpeg")
  const probe = path.join(directory, "ffprobe")
  fs.writeFileSync(explicit, "")
  fs.writeFileSync(probe, "")
  process.env.REC_FFMPEG_PATH = explicit
  process.env.REC_FFPROBE_PATH = probe
  process.env.REC_FFMPEG_DIR = directory
  const { ffmpegPath, ffprobePath } = await import(`${modulePath}?configured`)

  assert.equal(ffmpegPath(), explicit)
  assert.equal(ffprobePath(), probe)
})

test("searches PATH and gives an actionable error when a binary is absent", async (context) => {
  const directory = fixture(context)
  const ffmpeg = path.join(directory, "ffmpeg")
  fs.writeFileSync(ffmpeg, "")
  delete process.env.REC_FFMPEG_PATH
  delete process.env.REC_FFPROBE_PATH
  delete process.env.REC_FFMPEG_DIR
  process.env.PATH = directory
  const { ffmpegPath, ffprobePath } = await import(`${modulePath}?path`)

  assert.equal(ffmpegPath(), ffmpeg)
  assert.throws(() => ffprobePath(), /Missing ffprobe binary.*REC_FFPROBE_PATH/)
})
