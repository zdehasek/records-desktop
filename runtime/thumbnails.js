import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runCommand } from "./host-tools.js"
import {
  resolveMediaTool,
  toolArgs,
  toolCommand,
  toolOptions
} from "./media-tools.js"
import { mediaCacheKey } from "./src/services/media-cache-key.js"
import {
  clearThumbnails,
  deleteThumbnails,
  getThumbnail,
  openThumbnailDb,
  putThumbnail
} from "./src/services/thumbnail/thumbnail-db.js"

const magick = resolveMediaTool("magick")
const ffmpeg = resolveMediaTool("ffmpeg")
const sizes = { thumb: 512, micro: 80, year: 160 }
const THUMBNAIL_GENERATOR_VERSION = 1
const DEFAULT_MAX_CONCURRENT = 2

function abortError() {
  const error = new Error("Thumbnail generation aborted")
  error.name = "AbortError"
  error.code = "ABORT_ERR"
  return error
}

export function createThumbnailService(dataDirectory, options = {}) {
  openThumbnailDb(dataDirectory)
  const pending = new Map()
  const regenerating = new Map()
  const regeneratingSources = new Map()
  const sourceGenerations = new Map()
  const queue = []
  const maxConcurrent = Math.max(
    1,
    Number(options.maxConcurrent) || DEFAULT_MAX_CONCURRENT
  )
  let active = 0
  let generation = 0

  function sourceGeneration(sourceId) {
    return sourceGenerations.get(sourceId) || 0
  }

  function drainQueue() {
    while (active < maxConcurrent && queue.length) {
      const entry = queue.shift()
      if (entry.cancelled) continue
      entry.started = true
      entry.signal?.removeEventListener("abort", entry.abort)
      active += 1
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1
          drainQueue()
        })
    }
  }

  function schedule(task, signal) {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      const entry = {
        task,
        signal,
        resolve,
        reject,
        started: false,
        cancelled: false,
        abort: null
      }
      entry.abort = () => {
        if (entry.started || entry.cancelled) return
        entry.cancelled = true
        reject(abortError())
      }
      signal?.addEventListener("abort", entry.abort, { once: true })
      queue.push(entry)
      drainQueue()
    })
  }

  function observe(entry, signal) {
    if (!signal) {
      entry.persistent = true
      return entry.promise
    }
    if (signal.aborted) {
      if (!entry.persistent && entry.waiters === 0) entry.controller.abort()
      return Promise.reject(abortError())
    }
    entry.waiters += 1
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback, value, aborted = false) => {
        if (settled) return
        settled = true
        signal.removeEventListener("abort", onAbort)
        entry.waiters -= 1
        if (aborted && !entry.persistent && entry.waiters === 0) {
          entry.controller.abort()
        }
        callback(value)
      }
      const onAbort = () => finish(reject, abortError(), true)
      signal.addEventListener("abort", onAbort, { once: true })
      entry.promise.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      )
    })
  }

  async function generate(
    attachment,
    variant,
    force = false,
    generationOptions = {}
  ) {
    if (!sizes[variant]) return null
    const key = mediaCacheKey(attachment)
    const cacheRevision = `${key.sourceRevision}:thumb-v${THUMBNAIL_GENERATOR_VERSION}`
    if (!force) {
      const cached = getThumbnail(key.sourceId, cacheRevision, variant)
      if (cached) return cached
    }
    const token = generation
    const sourceToken = sourceGeneration(key.sourceId)
    const pendingKey = `${token}:${sourceToken}:${key.sourceId}:${cacheRevision}:${variant}`
    let entry = pending.get(pendingKey)
    if (entry?.controller.signal.aborted) {
      pending.delete(pendingKey)
      entry = null
    }
    if (!entry) {
      const controller = new AbortController()
      entry = {
        controller,
        promise: null,
        persistent: false,
        waiters: 0
      }
      entry.promise = schedule(
        () =>
          generateNow(
            attachment,
            variant,
            key,
            cacheRevision,
            token,
            sourceToken,
            controller.signal
          ),
        controller.signal
      ).finally(() => {
        if (pending.get(pendingKey) === entry) pending.delete(pendingKey)
      })
      pending.set(pendingKey, entry)
    }

    return observe(entry, generationOptions.signal)
  }

  async function generateNow(
    attachment,
    variant,
    key,
    cacheRevision,
    token,
    sourceToken,
    signal
  ) {
    if (
      generation !== token ||
      sourceGeneration(key.sourceId) !== sourceToken ||
      signal.aborted
    ) {
      return null
    }
    const size = sizes[variant]
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "records-thumb-")
    )
    const temporary = path.join(temporaryDirectory, "thumbnail.jpg")
    try {
      if (attachment.mime_type?.startsWith("video/") && ffmpeg) {
        await runCommand(
          toolCommand(ffmpeg),
          toolArgs(ffmpeg, [
            "-y",
            "-ss",
            "0",
            "-i",
            attachment.file_path,
            "-frames:v",
            "1",
            "-vf",
            `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
            temporary
          ]),
          toolOptions(ffmpeg, { signal })
        )
      } else if (attachment.mime_type?.startsWith("image/") && magick) {
        await runCommand(
          toolCommand(magick),
          toolArgs(magick, [
            `${attachment.file_path}[0]`,
            "-auto-orient",
            "-thumbnail",
            `${size}x${size}>`,
            "-strip",
            "-quality",
            "82",
            temporary
          ]),
          toolOptions(magick, { signal })
        )
      } else {
        return null
      }
      const buffer = fs.readFileSync(temporary)
      const currentKey = mediaCacheKey(attachment)
      if (
        generation !== token ||
        sourceGeneration(key.sourceId) !== sourceToken ||
        currentKey.sourceId !== key.sourceId ||
        currentKey.sourceRevision !== key.sourceRevision
      ) {
        return null
      }
      putThumbnail(key.sourceId, cacheRevision, variant, buffer)
      return buffer
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }

  function regenerate(attachment, variant = "thumb") {
    if (!sizes[variant]) return Promise.resolve(null)
    const sourceId = mediaCacheKey(attachment).sourceId
    const regenerationKey = `${sourceId}:${variant}`
    if (regenerating.has(regenerationKey)) {
      return regenerating.get(regenerationKey)
    }
    const sourceRegenerations = regeneratingSources.get(sourceId) || 0
    if (sourceRegenerations === 0) invalidate(attachment)
    regeneratingSources.set(sourceId, sourceRegenerations + 1)
    const promise = generate(attachment, variant, true).finally(() => {
      if (regenerating.get(regenerationKey) === promise) {
        regenerating.delete(regenerationKey)
      }
      const remaining = (regeneratingSources.get(sourceId) || 1) - 1
      if (remaining > 0) regeneratingSources.set(sourceId, remaining)
      else regeneratingSources.delete(sourceId)
    })
    regenerating.set(regenerationKey, promise)
    return promise
  }

  function invalidate(source) {
    if (!source || typeof source === "number") return false
    const sourceId = source.sourceId || mediaCacheKey(source).sourceId
    sourceGenerations.set(sourceId, sourceGeneration(sourceId) + 1)
    deleteThumbnails(sourceId)
    return true
  }

  function clear() {
    generation += 1
    sourceGenerations.clear()
    clearThumbnails()
  }

  return {
    available: Boolean(magick && ffmpeg),
    clear,
    generate,
    invalidate,
    regenerate
  }
}
