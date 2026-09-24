import fs from "fs"
import fsp from "fs/promises"
import path from "path"

import { runCommand } from "../../host-tools.js"
import { createLogger } from "../logger.js"
import { ffmpegPath, ffprobePath } from "./ffmpeg-binaries.js"
import { mediaCacheKey } from "./media-cache-key.js"

const log = createLogger("video-stream")

const pending = new Map()
const sourceGenerations = new Map()
const MP4_AUDIO_CODECS = new Set(["aac", "mp3", "mp4a"])
const H264_ENCODERS = ["libx264", "libopenh264"]

let encoderSetPromise = null
let cacheGeneration = 0

async function execFilePromise(file, args, options = {}) {
  try {
    const { stdout } = await runCommand(file, args, options)
    return stdout
  } catch (error) {
    const details = error.stderr?.toString()?.trim()
    throw new Error(details || error.message)
  }
}

async function probeStreams(filePath) {
  const stdout = await execFilePromise(
    ffprobePath(),
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_name,codec_type",
      "-of",
      "json",
      filePath
    ],
    { maxBuffer: 1024 * 1024 }
  )
  return JSON.parse(stdout)?.streams || []
}

function firstCodec(streams, type) {
  return (
    streams.find((stream) => stream.codec_type === type)?.codec_name || null
  )
}

function hasSupportedAudio(audioCodec, supported) {
  return !audioCodec || supported.has(audioCodec)
}

function canRemuxToMp4(streams) {
  const videoCodec = firstCodec(streams, "video")
  const audioCodec = firstCodec(streams, "audio")
  return (
    videoCodec === "h264" && hasSupportedAudio(audioCodec, MP4_AUDIO_CODECS)
  )
}

function sourceGeneration(sourceId) {
  return sourceGenerations.get(sourceId) || 0
}

function cachePathFor(cacheDir, key) {
  return path.join(cacheDir, `${key.sourceId}-${key.sourceRevision}.mp4`)
}

async function removeSourceCacheFiles(cacheDir, sourceId, keepPath = null) {
  let entries
  try {
    entries = await fsp.readdir(cacheDir)
  } catch {
    return
  }

  const prefix = `${sourceId}-`
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix))
      .map(async (entry) => {
        const fullPath = path.join(cacheDir, entry)
        if (fullPath === keepPath) return
        try {
          await fsp.rm(fullPath, { force: true })
        } catch {
          // ignore cache cleanup failures
        }
      })
  )
}

async function runFfmpeg(args) {
  await execFilePromise(ffmpegPath(), args, {
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024
  })
}

async function availableEncoders() {
  if (!encoderSetPromise) {
    encoderSetPromise = execFilePromise(
      ffmpegPath(),
      ["-hide_banner", "-encoders"],
      { maxBuffer: 1024 * 1024 }
    ).then((stdout) => {
      const encoders = new Set()
      for (const line of stdout.split("\n")) {
        const match = line.match(/^\s*V\S*\s+(\S+)/)
        if (match) encoders.add(match[1])
      }
      return encoders
    })
  }
  return encoderSetPromise
}

async function h264Encoder() {
  const encoders = await availableEncoders()
  return H264_ENCODERS.find((encoder) => encoders.has(encoder)) || null
}

function h264EncoderArgs(encoder) {
  if (encoder === "libx264") {
    return [
      "-c:v",
      encoder,
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p"
    ]
  }

  if (encoder === "libopenh264") {
    return ["-c:v", encoder, "-b:v", "2500k", "-pix_fmt", "yuv420p"]
  }

  throw new Error("No supported H.264 encoder found in ffmpeg")
}

function baseFfmpegArgs(filePath) {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-dn",
    "-sn"
  ]
}

async function remuxOrTranscode(filePath, streams, outputPath) {
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`
  const baseArgs = baseFfmpegArgs(filePath)

  try {
    if (canRemuxToMp4(streams)) {
      try {
        await runFfmpeg([
          ...baseArgs,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          "-f",
          "mp4",
          tmpPath
        ])
        await fsp.rename(tmpPath, outputPath)
        return
      } catch (err) {
        log.warn(`Remux failed, transcoding instead: ${err.message}`)
        await fsp.rm(tmpPath, { force: true })
      }
    }

    const encoder = await h264Encoder()
    await runFfmpeg([
      ...baseArgs,
      ...h264EncoderArgs(encoder),
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      tmpPath
    ])
    await fsp.rename(tmpPath, outputPath)
  } catch (err) {
    await fsp.rm(tmpPath, { force: true })
    throw err
  }
}

async function createStreamableVideo(
  source,
  key,
  _mimeType,
  dataDir,
  force,
  generationToken,
  sourceToken
) {
  const { filePath } = source
  const streams = await probeStreams(filePath)
  const cacheDir = path.join(dataDir, "streamable-video")
  await fsp.mkdir(cacheDir, { recursive: true, mode: 0o700 })
  await fsp.chmod(cacheDir, 0o700)
  const outputPath = cachePathFor(cacheDir, key)

  if (!force && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
    return { filePath: outputPath, mimeType: "video/mp4", converted: true }
  }

  const candidatePath = `${outputPath}.${process.pid}.${Date.now()}.pending`
  try {
    await remuxOrTranscode(filePath, streams, candidatePath)
    const currentKey = mediaCacheKey(source)
    if (
      cacheGeneration !== generationToken ||
      sourceGeneration(key.sourceId) !== sourceToken ||
      currentKey.sourceId !== key.sourceId ||
      currentKey.sourceRevision !== key.sourceRevision
    ) {
      throw new Error("Video source changed while creating derivative")
    }
    await fsp.chmod(candidatePath, 0o600)
    await fsp.rename(candidatePath, outputPath)
  } catch (err) {
    await fsp.rm(candidatePath, { force: true })
    throw err
  }
  await removeSourceCacheFiles(cacheDir, key.sourceId, outputPath)
  return { filePath: outputPath, mimeType: "video/mp4", converted: true }
}

export async function ensureStreamableVideo({
  source: sourceInput,
  filePath = sourceInput?.filePath || sourceInput?.file_path,
  mimeType,
  dataDir,
  force = false
}) {
  if (!mimeType?.startsWith("video/")) {
    return { filePath, mimeType, converted: false }
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Video file missing: ${filePath}`)
  }

  const source = sourceInput ? { ...sourceInput, filePath } : { filePath }
  const key = mediaCacheKey(source)
  const generationToken = cacheGeneration
  const sourceToken = sourceGeneration(key.sourceId)
  const pendingKey = `${path.resolve(dataDir)}:${generationToken}:${sourceToken}:${key.sourceId}:${key.sourceRevision}`
  if (pending.has(pendingKey)) return pending.get(pendingKey)

  const promise = createStreamableVideo(
    source,
    key,
    mimeType,
    dataDir,
    force,
    generationToken,
    sourceToken
  ).finally(() => pending.delete(pendingKey))
  pending.set(pendingKey, promise)
  return promise
}

export async function pruneStreamableVideo(dataDir, source) {
  const sourceId = source.sourceId || mediaCacheKey(source).sourceId
  sourceGenerations.set(sourceId, sourceGeneration(sourceId) + 1)
  await removeSourceCacheFiles(path.join(dataDir, "streamable-video"), sourceId)
}

export async function clearStreamableVideos(dataDir) {
  cacheGeneration += 1
  sourceGenerations.clear()
  await fsp.rm(path.join(dataDir, "streamable-video"), {
    recursive: true,
    force: true
  })
}
