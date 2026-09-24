import { createHash, randomBytes } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { Readable } from "node:stream"
import { fileURLToPath } from "node:url"
import { defaultDatabasePath, openDatabase } from "./database.js"
import { createRpc } from "./rpc.js"
import * as attachments from "./src/repositories/attachments.js"
import { initLogger } from "./src/logger.js"
import {
  closeTileCacheDb,
  openTileCacheDb
} from "./src/services/cache/tile-cache.js"
import { closeThumbnailDb } from "./src/services/thumbnail/thumbnail-db.js"
import { createThumbnailService } from "./thumbnails.js"
import { createWatchScanner } from "./watch-scanner.js"
import { ensureStreamableVideo } from "./src/services/video-stream.js"
import { createImageCaptionMetadata } from "./src/services/image-caption-metadata.js"
import { openRecordsConfig } from "./src/services/config-store.js"
import { ensurePrivateDirectory, recordsCacheDirectory } from "./src/paths.js"
import {
  findCommand,
  terminateActiveProcessTrees,
  terminateActiveProcessTreesSync
} from "./host-tools.js"
import { createSystemTrash } from "./src/services/system-trash.js"
import { openDuplicateStore } from "./src/services/duplicate-store.js"
import { createOnThisDayNotifications } from "./src/services/on-this-day-notifications.js"
import {
  activeProfileId,
  commitStartupProfile,
  profileInfo
} from "./src/profiles.js"

process.umask(0o077)

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.dirname(runtimeDirectory)
const frontendDirectory = path.join(repositoryRoot, "frontend", "dist")
const configuredToken = process.env.RECORDS_BASE_TOKEN
const token = /^[a-f0-9]{64}$/.test(configuredToken || "")
  ? configuredToken
  : randomBytes(32).toString("hex")
const basePath = `/${token}/`
initLogger({ level: process.env.RECORDS_LOG_LEVEL || "warn" })
const databasePath = defaultDatabasePath()
const config = openRecordsConfig()
const db = openDatabase(databasePath)
const events = new EventEmitter()
const cacheDirectory = ensurePrivateDirectory(recordsCacheDirectory())
const systemTrash = createSystemTrash(findCommand("gio"))
const duplicateStore = openDuplicateStore()
openTileCacheDb(cacheDirectory)
const thumbnails = createThumbnailService(
  path.join(cacheDirectory, "thumbnails")
)
const captionMetadata = createImageCaptionMetadata()
const watchScanner = createWatchScanner(db, events, {
  databasePath,
  config,
  trashService: systemTrash,
  duplicateStore,
  captionMetadata,
  onAttachmentChanged: (attachment) => thumbnails.invalidate(attachment)
})
let shuttingDown = false
let forcingShutdown = false
let thumbnailWarmupTimer = null
const rpc = createRpc(db, events, {
  databasePath,
  cacheDirectory,
  captionMetadata,
  thumbnails,
  watchScanner,
  config,
  requestShutdown: (exitCode) => shutdown(exitCode)
})
const onThisDayNotifications = createOnThisDayNotifications({
  config,
  notificationCommand: findCommand("omarchy-notification-send"),
  memoryDays: (date, opts) => rpc("days:memory", [date, opts])
})
const eventClients = new Set()
let currentPhotosImportProgress = {
  done: 0,
  total: 0,
  file: null,
  complete: true
}
let mapTilesUrlPromise = null

const MIME_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff2": "font/woff2"
}

function json(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  })
  response.end(body)
}

async function readBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 128 * 1024 * 1024) throw new Error("Request body too large")
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

function staticPath(relativePath) {
  const candidate = path.resolve(
    frontendDirectory,
    relativePath || "index.html"
  )
  const prefix = `${path.resolve(frontendDirectory)}${path.sep}`
  if (
    candidate !== path.join(frontendDirectory, "index.html") &&
    !candidate.startsWith(prefix)
  ) {
    throw new Error("Invalid static path")
  }
  return candidate
}

function serveFile(
  request,
  response,
  filePath,
  contentType,
  cacheControl = null
) {
  const stat = fs.statSync(filePath)
  const range = request.headers.range
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
      response.end()
      return
    }
    if (!match[1] && !match[2]) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
      response.end()
      return
    }
    const suffixLength = match[1] ? null : Number(match[2])
    const start = match[1]
      ? Number(match[1])
      : Math.max(stat.size - suffixLength, 0)
    const end = match[1]
      ? match[2]
        ? Math.min(Number(match[2]), stat.size - 1)
        : stat.size - 1
      : stat.size - 1
    if (
      stat.size === 0 ||
      start >= stat.size ||
      start > end ||
      suffixLength === 0
    ) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` })
      response.end()
      return
    }
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff"
    }
    if (cacheControl) headers["Cache-Control"] = cacheControl
    response.writeHead(206, headers)
    fs.createReadStream(filePath, { start, end }).pipe(response)
    return
  }

  const headers = {
    "Content-Length": stat.size,
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff"
  }
  if (cacheControl) headers["Cache-Control"] = cacheControl
  response.writeHead(200, headers)
  fs.createReadStream(filePath).pipe(response)
}

function serveBuffer(
  response,
  buffer,
  contentType,
  cacheControl = "private, max-age=86400",
  headers = {}
) {
  response.writeHead(200, {
    "Content-Length": buffer.length,
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "X-Content-Type-Options": "nosniff",
    ...headers
  })
  response.end(buffer)
}

function serveThumbnail(request, response, buffer, immutable = false) {
  const etag = `"${createHash("sha256").update(buffer).digest("base64url")}"`
  const cacheControl = immutable
    ? "private, max-age=31536000, immutable"
    : "private, no-cache"
  const headers = {
    "Cache-Control": cacheControl,
    ETag: etag,
    "X-Content-Type-Options": "nosniff"
  }
  if (request.headers["if-none-match"] === etag) {
    response.writeHead(304, headers)
    response.end()
    return
  }
  serveBuffer(response, buffer, "image/jpeg", cacheControl, {
    ETag: etag
  })
}

function broadcast(channel, data) {
  const payload = `event: ${channel}\ndata: ${JSON.stringify(data ?? null)}\n\n`
  for (const response of eventClients) response.write(payload)
}

function resolveMapTilesUrl() {
  if (mapTilesUrlPromise) return mapTilesUrlPromise
  mapTilesUrlPromise = (async () => {
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date()
      date.setDate(date.getDate() - offset)
      const dateString = date.toISOString().slice(0, 10).replace(/-/g, "")
      const url = `https://build.protomaps.com/${dateString}.pmtiles`
      try {
        const result = await fetch(url, {
          method: "HEAD",
          signal: AbortSignal.timeout(5000)
        })
        if (result.ok) return url
      } catch {
        // try previous daily build
      }
    }
    return "https://build.protomaps.com/20260218.pmtiles"
  })()
  return mapTilesUrlPromise
}

function copyUpstreamHeader(headers, upstream, name) {
  const value = upstream.headers.get(name)
  if (value) headers[name] = value
}

function mapResponseHeaders(upstream) {
  const headers = {
    "Accept-Ranges": upstream.headers.get("accept-ranges") ?? "bytes",
    "Cache-Control": "public, max-age=86400",
    "Content-Type": "application/octet-stream"
  }
  copyUpstreamHeader(headers, upstream, "content-length")
  copyUpstreamHeader(headers, upstream, "content-range")
  copyUpstreamHeader(headers, upstream, "etag")
  return headers
}

async function serveMapTiles(request, response) {
  const clientAbort = new AbortController()
  const abort = () => clientAbort.abort()
  request.once("aborted", abort)
  response.once("close", () => abortOpenResponse(response, abort))
  try {
    const upstream = await fetch(await resolveMapTilesUrl(), {
      headers: mapRequestHeaders(request),
      signal: AbortSignal.any([clientAbort.signal, AbortSignal.timeout(15_000)])
    })
    pipeMapResponse(upstream, response)
  } finally {
    request.off("aborted", abort)
  }
}

function abortOpenResponse(response, abort) {
  if (!response.writableEnded) abort()
}

function mapRequestHeaders(request) {
  return request.headers.range ? { Range: request.headers.range } : {}
}

function pipeMapResponse(upstream, response) {
  if (!upstream.ok) {
    throw new Error(`Map tile request failed: ${upstream.status}`)
  }
  response.writeHead(upstream.status, mapResponseHeaders(upstream))
  if (!upstream.body) {
    response.end()
    return
  }
  Readable.fromWeb(upstream.body).pipe(response)
}

function glyphCachePath(glyphUrl) {
  const glyphDirectory = ensurePrivateDirectory(
    path.join(cacheDirectory, "map-glyphs")
  )
  return path.join(
    glyphDirectory,
    `${createHash("sha256").update(glyphUrl).digest("hex")}.pbf`
  )
}

async function glyphData(glyphUrl, cachePath) {
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath)
  const upstream = await fetch(glyphUrl, {
    signal: AbortSignal.timeout(5000)
  })
  if (!upstream.ok) throw new Error(`Glyph request failed: ${upstream.status}`)
  const data = Buffer.from(await upstream.arrayBuffer())
  fs.writeFileSync(cachePath, data, { mode: 0o600 })
  return data
}

async function serveGlyph(response, fontStack, range) {
  const glyphUrl = `https://cdn.protomaps.com/fonts/pbf/${encodeURIComponent(fontStack)}/${range}.pbf`
  const data = await glyphData(glyphUrl, glyphCachePath(glyphUrl))
  serveBuffer(response, data, "application/x-protobuf")
}

for (const channel of [
  "data-changed",
  "photos-import-progress",
  "thumbnails-progress",
  "thumbnails-micro-progress",
  "thumbnails-year-progress",
  "video-stream-progress"
]) {
  events.on(channel, (data) => {
    if (channel === "photos-import-progress") {
      currentPhotosImportProgress = data
    }
    broadcast(channel, data)
  })
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1")
    if (!url.pathname.startsWith(basePath)) {
      json(response, 404, { error: "Not found" })
      return
    }
    const relativePath = decodeURIComponent(url.pathname.slice(basePath.length))

    if (request.method === "POST" && relativePath === "rpc") {
      const body = await readBody(request)
      const result = await rpc(body.method, body.args)
      json(response, 200, { result })
      return
    }

    if (request.method === "GET" && relativePath === "events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      })
      response.write("event: ready\ndata: null\n\n")
      response.write(
        `event: photos-import-progress\ndata: ${JSON.stringify(currentPhotosImportProgress)}\n\n`
      )
      eventClients.add(response)
      request.on("close", () => eventClients.delete(response))
      return
    }

    if (request.method === "GET" && relativePath === "basemap.pmtiles") {
      await serveMapTiles(request, response)
      return
    }

    const glyphMatch = /^glyphs\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(relativePath)
    if (request.method === "GET" && glyphMatch) {
      await serveGlyph(response, glyphMatch[1], glyphMatch[2])
      return
    }

    const mediaMatch = /^media\/(\d+)(?:\/(thumb|micro|year|stream))?$/.exec(
      relativePath
    )
    if (request.method === "GET" && mediaMatch) {
      let attachment = null
      try {
        attachment = attachments.get(db, Number(mediaMatch[1]), config)
      } catch (error) {
        if (error.message !== "unsafe root resolution") throw error
      }
      let mediaStat = null
      let rootStat = null
      try {
        mediaStat = attachment?.file_path
          ? fs.lstatSync(attachment.file_path)
          : null
        const root = attachment
          ? config
              .mediaRoots()
              .find(({ name }) => name === attachment.root_name)
          : null
        rootStat = root ? fs.lstatSync(root.path) : null
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
      if (
        !attachment ||
        !rootStat?.isDirectory() ||
        rootStat.isSymbolicLink() ||
        !mediaStat?.isFile() ||
        mediaStat.isSymbolicLink()
      ) {
        json(response, 404, { error: "Attachment not found" })
        return
      }
      if (mediaMatch[2] === "stream") {
        if (!attachment.mime_type?.startsWith("video/")) {
          json(response, 415, { error: "Attachment is not a video" })
          return
        }
        const streamable = await ensureStreamableVideo({
          source: attachment,
          mimeType: attachment.mime_type,
          dataDir: cacheDirectory,
          force: url.searchParams.get("force") === "1"
        })
        serveFile(
          request,
          response,
          streamable.filePath,
          streamable.mimeType,
          "private, no-store"
        )
        return
      }
      if (mediaMatch[2] && mediaMatch[2] !== "stream") {
        const controller = new AbortController()
        const abort = () => controller.abort()
        const close = () => {
          if (!response.writableEnded) abort()
        }
        request.once("aborted", abort)
        response.once("close", close)
        let thumbnail
        try {
          thumbnail = await thumbnails.generate(
            attachment,
            mediaMatch[2],
            false,
            { signal: controller.signal }
          )
        } catch (error) {
          if (controller.signal.aborted) return
          throw error
        } finally {
          request.off("aborted", abort)
          response.off("close", close)
        }
        if (thumbnail) {
          serveThumbnail(
            request,
            response,
            thumbnail,
            url.searchParams.has("rev")
          )
          return
        }
        json(response, 503, { error: "Thumbnail unavailable" })
        return
      }
      const contentType =
        attachment.mime_type ||
        MIME_TYPES[path.extname(attachment.file_path).toLowerCase()] ||
        "application/octet-stream"
      serveFile(
        request,
        response,
        attachment.file_path,
        contentType,
        "private, no-store"
      )
      return
    }

    if (request.method === "GET") {
      const requested = relativePath === "" ? "index.html" : relativePath
      const filePath = staticPath(requested)
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        json(response, 404, { error: "Not found" })
        return
      }
      const extension = path.extname(filePath).toLowerCase()
      const headers = {
        "Content-Type": MIME_TYPES[extension] || "application/octet-stream",
        "Cache-Control":
          requested === "index.html"
            ? "no-store"
            : "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff"
      }
      if (requested === "index.html") {
        headers["Content-Security-Policy"] =
          "default-src 'self' data: blob:; connect-src 'self' https://build.protomaps.com https://cdn.protomaps.com https://*.protomaps.com https://photon.komoot.io; img-src 'self' data: blob:; worker-src 'self' blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-eval'"
      }
      response.writeHead(200, headers)
      fs.createReadStream(filePath).pipe(response)
      return
    }

    json(response, 405, { error: "Method not allowed" })
  } catch (error) {
    json(response, 500, { error: error.message })
  }
})

let listening = false

async function closeResources() {
  if (thumbnailWarmupTimer) clearTimeout(thumbnailWarmupTimer)
  thumbnailWarmupTimer = null
  for (const response of eventClients) response.end()
  onThisDayNotifications.stop()
  const cleanup = [terminateActiveProcessTrees(), watchScanner.stop()]
  if (listening) cleanup.push(new Promise((resolve) => server.close(resolve)))
  const results = await Promise.allSettled(cleanup)
  listening = false
  let cleanupError = results.find(
    (result) => result.status === "rejected"
  )?.reason
  for (const close of [closeThumbnailDb, closeTileCacheDb, () => db.close()]) {
    try {
      close()
    } catch (error) {
      cleanupError ||= error
    }
  }
  if (cleanupError) throw cleanupError
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await closeResources()
  } finally {
    process.exit(exitCode)
  }
}

function forceShutdown() {
  if (forcingShutdown) {
    watchScanner.forceStopWorker()
    terminateActiveProcessTreesSync()
    process.exit(1)
  }
  forcingShutdown = true
  void Promise.allSettled([
    terminateActiveProcessTrees({ graceMs: 100 }),
    watchScanner.stop({ workerStopGraceMs: 100 })
  ]).finally(() => process.exit(1))
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    if (shuttingDown) {
      forceShutdown()
      return
    }
    void shutdown(0)
  })
}

const configuredPort = Number(process.env.RECORDS_PORT || 0)
const port =
  Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 0

async function initializeProjection() {
  try {
    await watchScanner.start()
    if (shuttingDown) return
    thumbnailWarmupTimer = setTimeout(() => {
      thumbnailWarmupTimer = null
      if (shuttingDown) return
      rpc("thumbnails:warmup").catch((error) =>
        console.error("Thumbnail warmup failed", error)
      )
    }, 15_000)
    thumbnailWarmupTimer.unref?.()
  } catch (error) {
    if (!shuttingDown) {
      console.error("Records projection initialization failed", error)
    }
  }
}

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      listening = true
      resolve()
    })
  })
  const address = server.address()
  const profile = profileInfo(activeProfileId())
  commitStartupProfile(profile.id)
  onThisDayNotifications.start()
  process.stdout.write(
    `RECORDS_READY ${JSON.stringify({ url: `http://127.0.0.1:${address.port}${basePath}`, profile })}\n`
  )
  void initializeProjection()
} catch (error) {
  shuttingDown = true
  try {
    await closeResources()
  } catch (cleanupError) {
    error.cause ||= cleanupError
  }
  throw error
}
