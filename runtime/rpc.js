import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import * as attachments from "./src/repositories/attachments.js"
import * as days from "./src/repositories/days.js"
import * as messages from "./src/repositories/messages.js"
import {
  cleanupImportDirectories,
  deleteOwnedMedia,
  prepareImportPath
} from "./src/services/media-destination.js"
import {
  clearTileCache,
  getCachedTile,
  getTileCacheStats,
  putCachedTile
} from "./src/services/cache/tile-cache.js"
import {
  projectMessageMetadata,
  readMediaMetadata,
  resolveMediaCreatedAt,
  resolveMediaMimeType
} from "./media-metadata.js"
import { resolveMediaTool } from "./media-tools.js"
import { platform as selectedPlatform } from "./platform.js"
import {
  clearStreamableVideos,
  pruneStreamableVideo
} from "./src/services/video-stream.js"
import {
  companionPath,
  readMediaCompanion
} from "./src/services/media-companion.js"
import { openDuplicateStore } from "./src/services/duplicate-store.js"
import { moveVisibility } from "./src/services/visibility-path.js"
import { createPhotoGif } from "./src/services/photo-gif.js"
import { updateMediaAttachment } from "./src/services/media-update.js"
import {
  activeProfileId,
  createProfile,
  listProfiles,
  profileInfo,
  requestProfileSwitch
} from "./src/profiles.js"

const MIME_TYPES = {
  ".avi": "video/x-msvideo",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4v": "video/x-m4v",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webm": "video/webm",
  ".webp": "image/webp"
}

function checksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = fs.createReadStream(filePath)
    stream.on("error", reject)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
  })
}

function validateCoordinates(latitude, longitude) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error("Latitude must be between -90 and 90")
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error("Longitude must be between -180 and 180")
  }
}

function memoryConfig(defaultRoot) {
  const roots = []
  if (defaultRoot) {
    fs.mkdirSync(defaultRoot, { recursive: true, mode: 0o700 })
    roots.push({ name: "records", path: defaultRoot, enabled: true })
  }
  let selectedName = roots[0]?.name || null
  const settings = new Map()
  return {
    mediaRoots: ({ enabledOnly = false } = {}) =>
      roots.filter((root) => !enabledOnly || root.enabled),
    defaultMediaRoot: () =>
      roots.find((root) => root.name === selectedName) || null,
    addMediaRoot: (rootPath) => {
      const root = {
        name: `media-${roots.length + 1}`,
        path: path.resolve(rootPath),
        enabled: true
      }
      roots.push(root)
      selectedName ||= root.name
      return root
    },
    removeMediaRoot: (rootPath) => {
      const index = roots.findIndex(
        (root) => root.path === path.resolve(rootPath)
      )
      if (index < 0) return false
      if (roots[index].name === selectedName && roots.length > 1) {
        throw new Error(
          "Choose another default folder before removing this one"
        )
      }
      const [removed] = roots.splice(index, 1)
      if (removed.name === selectedName) selectedName = null
      return true
    },
    toggleMediaRoot: (rootPath, enabled) => {
      const root = roots.find((item) => item.path === path.resolve(rootPath))
      if (!root) throw new Error("media folder not found")
      if (!enabled && root.name === selectedName) {
        throw new Error("Choose another default folder before pausing this one")
      }
      root.enabled = Boolean(enabled)
      return root
    },
    setDefaultMediaRoot: (rootPath) => {
      const root = roots.find((item) => item.path === path.resolve(rootPath))
      if (!root || !root.enabled) throw new Error("media folder not found")
      selectedName = root.name
      return root
    },
    getSetting: (key) => settings.get(key),
    allSettings: () => Object.fromEntries(settings),
    setSetting: (key, value) => {
      settings.set(key, value)
      return { key, value }
    }
  }
}

export function createRpc(db, events, options = {}) {
  const runtimePlatform = options.platform || selectedPlatform
  const databasePath = options.databasePath || "records.sqlite3"
  const defaultMediaRoot = options.defaultMediaRoot
  const {
    captionMetadata,
    thumbnails,
    watchScanner,
    config: configuredConfig,
    duplicateStore = openDuplicateStore()
  } = options
  const systemPackages = options.systemPackages || {
    ffmpeg: Boolean(resolveMediaTool("ffmpeg") && resolveMediaTool("ffprobe")),
    glib2:
      runtimePlatform.name !== "omarchy" ||
      Boolean(runtimePlatform.resolveHostTool("gio")),
    imagemagick: Boolean(resolveMediaTool("magick")),
    nautilus:
      runtimePlatform.name !== "omarchy" ||
      Boolean(runtimePlatform.resolveHostTool("nautilus")),
    zenity:
      runtimePlatform.name !== "omarchy" ||
      Boolean(runtimePlatform.resolveHostTool("zenity")),
    "perl-image-exiftool": Boolean(resolveMediaTool("exiftool"))
  }
  const missingSystemPackages = Object.entries(systemPackages)
    .filter(([name, available]) => name !== "perl-image-exiftool" && !available)
    .map(([name]) => name)
  const missingOptionalSystemPackages = systemPackages["perl-image-exiftool"]
    ? []
    : ["perl-image-exiftool"]
  const config = configuredConfig || memoryConfig(defaultMediaRoot)
  const requestShutdown = options.requestShutdown || (() => {})
  const chooseFilePath =
    options.choosePath ||
    ((directory) =>
      directory ? runtimePlatform.chooseFolder() : runtimePlatform.chooseFile())
  const readMetadata = options.readMediaMetadata || readMediaMetadata
  const systemTrash = options.trashService || {
    available: true,
    move: (filePath) => runtimePlatform.moveToTrash(filePath)
  }
  const rootForAttachment = (attachment) => {
    const root = config
      .mediaRoots()
      .find((entry) => entry.name === attachment.root_name)
    if (!root)
      throw new Error(`Media root is unavailable: ${attachment.root_name}`)
    return root
  }
  const currentDefaultMediaRoot = () => {
    const root = config.defaultMediaRoot()
    if (!root) {
      throw new Error(
        "Choose a default media folder in Settings before adding media"
      )
    }
    if (!root.enabled) throw new Error("The default media folder is paused")
    let stat
    try {
      stat = fs.lstatSync(root.path)
    } catch {
      throw new Error("The default media folder is not available")
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("The default media folder must be an ordinary directory")
    }
    return root
  }
  const destroyMessage = (messageId) => messages.destroy(db, messageId)
  const purgeMessage = async (messageId) => {
    const message = messages.get(db, messageId)
    if (!message) return { changes: 0 }
    const rows = [attachments.get(db, messageId, config)].filter(Boolean)
    if (rows.some((attachment) => attachment.is_symlink)) {
      throw new Error("symlink items are view-only")
    }
    if (!systemTrash.available && options.trashService === undefined) {
      throw new Error("System Trash is unavailable")
    }
    for (const attachment of rows) {
      if (!fs.existsSync(attachment.file_path)) continue
      const sidecar = companionPath(attachment.file_path)
      if (!fs.existsSync(sidecar)) {
        await systemTrash.move(attachment.file_path)
        continue
      }
      const staging = path.join(
        path.dirname(attachment.file_path),
        `.records-trash-${randomUUID()}`
      )
      fs.mkdirSync(staging)
      const stagedMedia = path.join(
        staging,
        path.basename(attachment.file_path)
      )
      const stagedCompanion = path.join(staging, path.basename(sidecar))
      try {
        fs.renameSync(attachment.file_path, stagedMedia)
        fs.renameSync(sidecar, stagedCompanion)
        await systemTrash.move(staging)
      } catch (error) {
        if (fs.existsSync(stagedCompanion))
          fs.renameSync(stagedCompanion, sidecar)
        if (fs.existsSync(stagedMedia))
          fs.renameSync(stagedMedia, attachment.file_path)
        fs.rmSync(staging, { recursive: true, force: true })
        throw error
      }
    }
    return destroyMessage(messageId)
  }
  const missingAttachmentRows = (opts = {}) =>
    attachments
      .listMissingImported(db, opts, config)
      .filter((row) => !fs.existsSync(row.file_path))
  const mapMissingAttachment = (row) => ({
    attachmentId: row.id,
    messageId: row.message_id,
    fileName: row.file_name,
    filePath: row.file_path,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    visibility: row.visibility,
    messageName:
      String(row.message_content || "")
        .replace(/<[^>]*>/g, "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) || null,
    dayId: row.day_id,
    dayDate: row.day_date
  })
  const copyPickedCompanion = (sourcePath, filePath, mimeType) => {
    if (!mimeType.startsWith("video/")) return
    const sourceCompanion = companionPath(sourcePath)
    if (!fs.existsSync(sourceCompanion)) return
    readMediaCompanion(sourcePath)
    fs.copyFileSync(sourceCompanion, companionPath(filePath))
    fs.chmodSync(companionPath(filePath), 0o600)
  }
  const pickedFingerprint = async (filePath, mimeType, digest) => {
    if (
      !mimeType.startsWith("image/") ||
      !captionMetadata?.contentFingerprint
    ) {
      return digest
    }
    return (
      (await captionMetadata.contentFingerprint(filePath).catch(() => null)) ||
      digest
    )
  }
  const projectPickedMedia = async (filePath, fallbackMimeType, mediaRoot) => {
    const stat = fs.statSync(filePath)
    const mediaMetadata = await readMetadata(filePath, {
      captionMetadata: fallbackMimeType.startsWith("image/")
        ? captionMetadata
        : null
    })
    const mimeType = resolveMediaMimeType(fallbackMimeType, mediaMetadata)
    const companion = mimeType.startsWith("video/")
      ? readMediaCompanion(filePath)
      : null
    const createdAt = resolveMediaCreatedAt(
      mediaMetadata,
      stat.mtime.toISOString(),
      companion?.metadata.date_override
    )
    const projectedMetadata = projectMessageMetadata(mediaMetadata, {
      important: companion?.metadata.important ?? mediaMetadata.important,
      noteColor:
        companion?.metadata.note_style?.color || mediaMetadata.presentationColor
    })
    const digest = await checksum(filePath)
    const fingerprint = await pickedFingerprint(
      filePath,
      fallbackMimeType,
      digest
    )
    return messages.addPhoto(
      db,
      days.ensure(db, createdAt.slice(0, 10)).id,
      filePath,
      path.basename(filePath),
      mimeType,
      stat.size,
      digest,
      mediaMetadata.exifData || null,
      mediaMetadata.latitude ?? null,
      mediaMetadata.longitude ?? null,
      Object.keys(projectedMetadata).length ? projectedMetadata : null,
      createdAt,
      mediaRoot,
      companion?.content ||
        (mediaMetadata.captionConflict ? "" : mediaMetadata.caption || ""),
      { contentFingerprint: fingerprint || null }
    )
  }
  const mutatingCustomMethods = new Set([
    "attachments:update",
    "messages:delete",
    "messages:batch-delete",
    "messages:set-visibility",
    "messages:batch-set-visibility",
    "messages:rename-folder",
    "settings:set",
    "attachments:pick-and-add",
    "attachments:purge-missing-imported",
    "attachments:write-gps-to-file",
    "photos:create-gif",
    "media-folders:add",
    "media-folders:remove",
    "media-folders:toggle",
    "media-folders:set-default"
  ])
  const custom = {
    "messages:list": (dayId, opts = {}) => messages.list(db, dayId, opts),
    "attachments:update": (id, fields) =>
      updateMediaAttachment(db, id, fields, {
        config,
        captionMetadata,
        thumbnails,
        readMediaCompanion: options.readMediaCompanion,
        writeMediaCompanion: options.writeMediaCompanion
      }),
    "messages:delete": (id) => purgeMessage(id),
    "messages:batch-delete": async (ids) => {
      for (const id of ids) await purgeMessage(id)
      return { success: true }
    },
    "messages:set-visibility": async (id, visibility) => {
      const message = messages.get(db, id)
      if (!message) throw new Error("Media message not found")
      const rows = [attachments.get(db, id, config)].filter(Boolean)
      for (const attachment of rows) {
        const root = rootForAttachment(attachment)
        const kind =
          visibility === "visible"
            ? "visible"
            : visibility.startsWith(".")
              ? "hidden"
              : "nsfw"
        const category =
          visibility === "visible" ? "general" : visibility.replace(/^\./, "")
        const nextRelativePath = moveVisibility({
          root,
          relativePath: attachment.relative_path,
          visibility: kind,
          category,
          duplicateStore
        })
        db.prepare(
          "UPDATE attachments SET relative_path = ?, source_revision = NULL WHERE id = ?"
        ).run(nextRelativePath, attachment.id)
      }
      return messages.setVisibility(db, id)
    },
    "messages:batch-set-visibility": async (ids, visibility) => {
      for (const id of ids) {
        await custom["messages:set-visibility"](id, visibility)
      }
      return ids.length
    },
    "messages:rename-folder": async (oldName, newName) => {
      const affected = messages.listFolderItems(db, oldName)
      for (const message of affected) {
        await custom["messages:set-visibility"](message.id, newName)
      }
      return affected.length
    },
    "days:list-with-content": (opts = {}) => days.listWithContent(db, opts),
    "days:get": (dayId, opts = {}) => days.get(db, dayId, opts),
    "days:list-for-range": (startDate, endDate, opts = {}) =>
      days.listForRange(db, startDate, endDate, opts),
    "days:list-for-year": (year, opts = {}) =>
      days.listForRange(db, `${year}-01-01`, `${year}-12-31`, opts),
    "days:memory": (date, opts = {}) =>
      date ? days.memory(db, date, opts) : [],
    "days:story-items": (date, opts = {}) =>
      date ? days.storyItems(db, date, opts, config) : [],
    "settings:all": () => config.allSettings(),
    "settings:set": (key, value) => config.setSetting(key, value),
    "attachments:open": (id) => {
      const attachment = attachments.get(db, id, config)
      if (!attachment) throw new Error("Attachment not found")
      return runtimePlatform.openFile(attachment.file_path)
    },
    "attachments:show-in-folder": (id) => {
      const attachment = attachments.get(db, id, config)
      if (!attachment) throw new Error("Attachment not found")
      return runtimePlatform.revealFile(attachment.file_path)
    },
    "attachments:pick-and-add": async (dayId) => {
      const defaultRoot = currentDefaultMediaRoot()
      const sourcePath = await chooseFilePath()
      if (!sourcePath) return null
      const day = days.get(db, dayId)
      if (!day) throw new Error("Day not found")
      const destination = prepareImportPath(
        defaultRoot.path,
        day.date,
        sourcePath
      )
      const { filePath } = destination
      try {
        fs.copyFileSync(sourcePath, filePath)
        fs.chmodSync(filePath, 0o600)
        const fallbackMimeType =
          MIME_TYPES[path.extname(filePath).toLowerCase()] ||
          "application/octet-stream"
        copyPickedCompanion(sourcePath, filePath, fallbackMimeType)
        return projectPickedMedia(filePath, fallbackMimeType, defaultRoot)
      } catch (error) {
        fs.rmSync(companionPath(filePath), { force: true })
        deleteOwnedMedia(
          { file_path: filePath, root_path: defaultRoot.path },
          defaultRoot.path
        )
        cleanupImportDirectories(destination.created)
        throw error
      }
    },
    "attachments:list-missing-imported": (opts = {}) =>
      missingAttachmentRows(opts).map(mapMissingAttachment),
    "attachments:purge-missing-imported": () => {
      const rows = missingAttachmentRows()
      const messageIds = [...new Set(rows.map((row) => row.message_id))]
      for (const messageId of messageIds) destroyMessage(messageId)
      return {
        removedMessages: messageIds.length,
        removedAttachments: rows.length
      }
    },
    "attachments:list-duplicate-groups": () => {
      const rows = db
        .prepare(
          `SELECT * FROM attachments
         WHERE content_fingerprint IN (
            SELECT content_fingerprint FROM attachments
            WHERE content_fingerprint IS NOT NULL
            GROUP BY content_fingerprint HAVING COUNT(*) > 1
          ) ORDER BY content_fingerprint, created_at, root_name, relative_path`
        )
        .all()
      const groups = new Map()
      for (const row of rows) {
        if (!groups.has(row.content_fingerprint)) {
          const durable = duplicateStore.read(row.content_fingerprint)
          groups.set(row.content_fingerprint, {
            checksum: row.content_fingerprint,
            canonical: durable?.canonical || null,
            canonicalAttachmentId: null,
            members: []
          })
        }
        const group = groups.get(row.content_fingerprint)
        const attachment = attachments.get(db, row.id, config)
        const message = messages.get(db, row.id)
        const reference = { root: row.root_name, path: row.relative_path }
        const isCanonical = group.canonical
          ? group.canonical.root === reference.root &&
            group.canonical.path === reference.path
          : group.members.length === 0
        if (isCanonical) group.canonicalAttachmentId = row.id
        group.members.push({
          id: `attachment:${row.id}`,
          attachmentId: row.id,
          messageId: row.id,
          fileName: attachment.file_name,
          filePath: attachment.file_path,
          root: row.root_name,
          path: row.relative_path,
          mimeType: row.mime_type,
          createdAt: row.created_at,
          dayDate: row.created_at.slice(0, 10),
          visibility: message.visibility,
          messageContent: row.content,
          isCanonical,
          canDelete: !isCanonical,
          canSetDefault: !isCanonical
        })
      }
      return [...groups.values()]
    },
    "attachments:set-duplicate-canonical": (fingerprint, attachmentId) => {
      const selected = db
        .prepare(
          "SELECT id, root_name, relative_path, content_fingerprint FROM attachments WHERE id = ?"
        )
        .get(attachmentId)
      if (!selected) throw new Error("Attachment not found")
      if (selected.content_fingerprint !== fingerprint)
        throw new Error("Attachment content fingerprint mismatch")
      const existing = duplicateStore.read(fingerprint)
      const projected = db
        .prepare(
          "SELECT root_name, relative_path FROM attachments WHERE content_fingerprint = ? AND id != ?"
        )
        .all(fingerprint, attachmentId)
        .map((row) => ({ root: row.root_name, path: row.relative_path }))
      const canonical = {
        root: selected.root_name,
        path: selected.relative_path
      }
      const references = [
        ...(existing?.duplicates || []),
        ...(existing ? [existing.canonical] : []),
        ...projected
      ]
      const duplicates = [
        ...new Map(
          references
            .filter(
              (item) =>
                item.root !== canonical.root || item.path !== canonical.path
            )
            .map((item) => [`${item.root}:${item.path}`, item])
        ).values()
      ]
      duplicateStore.write(fingerprint, { ...existing, canonical, duplicates })
      return {
        checksum: fingerprint,
        canonicalAttachmentId: attachmentId,
        canonical
      }
    },
    "attachments:write-gps-to-file": async (id, latitude, longitude) => {
      validateCoordinates(latitude, longitude)
      const attachment = await updateMediaAttachment(
        db,
        id,
        { latitude, longitude },
        { config, captionMetadata, thumbnails }
      )
      return {
        success: true,
        fileWritten: true,
        attachment
      }
    },
    "photos:create-gif": async (selections) => {
      const result = await createPhotoGif(db, selections, {
        config,
        captionMetadata,
        ffmpeg: options.ffmpeg,
        execFile: options.execFile
      })
      await watchScanner.scan()
      return {
        ...result,
        attachment: attachments.get(
          db,
          db
            .prepare(
              "SELECT id FROM attachments WHERE root_name = ? AND relative_path = ?"
            )
            .get(result.root, result.path)?.id,
          config
        )
      }
    },
    "media-folders:add": async () => {
      const dirPath = await chooseFilePath(true)
      if (!dirPath) return null
      if (
        config.mediaRoots().some((root) => root.path === path.resolve(dirPath))
      ) {
        return { duplicate: true }
      }
      const result = config.addMediaRoot(dirPath)
      if (!result) return { duplicate: true }
      watchScanner.syncWatchers()
      watchScanner.requestScan()
      return {
        ...result,
        exists: true,
        isDefault: config.defaultMediaRoot()?.name === result.name
      }
    },
    "media-folders:list": () => {
      const defaultName = config.defaultMediaRoot()?.name
      const countIndexed = db.prepare(
        "SELECT COUNT(*) AS count FROM attachments WHERE root_name = ?"
      )
      return config.mediaRoots().map((root) => ({
        ...root,
        exists: fs.existsSync(root.path),
        isDefault: root.name === defaultName,
        indexedCount: Number(countIndexed.get(root.name).count)
      }))
    },
    "media-folders:remove": async (dirPath) => {
      const candidate = path.resolve(dirPath)
      const root = config.mediaRoots().find((item) => item.path === candidate)
      if (!root) return false
      config.removeMediaRoot(candidate)
      const removed = await watchScanner.pruneRootWhenIdle(root, {
        emit: false,
        notify: false
      })
      watchScanner.syncWatchers?.()
      await pruneDerivatives(removed)
      return true
    },
    "media-folders:toggle": async (dirPath, enabled) => {
      if (typeof enabled !== "boolean") {
        throw new Error("media folder enabled state must be boolean")
      }
      const root = config.toggleMediaRoot(dirPath, enabled)
      let removed = []
      if (enabled && fs.existsSync(root.path)) {
        await watchScanner.replaceRoot(root, {
          emit: false,
          notify: false
        })
      } else if (!enabled) {
        removed = await watchScanner.pruneRootWhenIdle(root, {
          emit: false,
          notify: false
        })
      }
      watchScanner.syncWatchers?.()
      await pruneDerivatives(removed)
      return root
    },
    "media-folders:set-default": (dirPath) => {
      const root = config.setDefaultMediaRoot(dirPath)
      return { ...root, isDefault: true }
    },
    "thumbnails:warmup": () => warmThumbnails("thumb", "thumbnails-progress"),
    "thumbnails:warmup-micro": () =>
      warmThumbnails("micro", "thumbnails-micro-progress"),
    "thumbnails:regenerate": async (id, variant = "thumb") => {
      const attachment = attachments.get(db, id, config)
      if (!attachment) throw new Error("Attachment not found")
      const thumbnail = await thumbnails.regenerate(attachment, variant)
      return thumbnail
        ? { ok: true }
        : { ok: false, reason: "generation-failed" }
    },
    "thumbnails:regenerate-all": () =>
      warmThumbnails("thumb", "thumbnails-progress", true),
    "map-tiles:stats": () => getTileCacheStats(),
    "map-tiles:get": (z, x, y) => {
      const buffer = getCachedTile(z, x, y)
      return buffer ? [...buffer] : null
    },
    "map-tiles:put": (z, x, y, data) => {
      if (
        !Array.isArray(data) ||
        !data.length ||
        data.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255
        )
      ) {
        throw new Error("Invalid map tile data")
      }
      putCachedTile(z, x, y, Buffer.from(data))
      return true
    },
    "map-tiles:clear": () => {
      clearTileCache()
      return { success: true }
    },
    "profiles:list": () => ({
      active: profileInfo(activeProfileId()),
      profiles: listProfiles()
    }),
    "profiles:create": (input) => createProfile(input),
    "profiles:switch": (profileId) => {
      if (profileId === activeProfileId()) {
        return { switching: false, profile: profileInfo(profileId) }
      }
      const id = requestProfileSwitch(profileId)
      runtimePlatform.requestRestart(requestShutdown)
      return { switching: true, profile: profileInfo(id) }
    },
    "system:capabilities": () => ({
      ...runtimePlatform.capabilities(),
      profile: profileInfo(activeProfileId()),
      photoGif: systemPackages.ffmpeg,
      missingOptionalSystemPackages,
      missingSystemPackages,
      thumbnails: thumbnails.available,
      mediaFolders: true,
      photoCaptionMetadata: captionMetadata?.capabilities() || {
        read: false,
        write: false
      }
    })
  }

  async function warmThumbnails(variant, channel, force = false) {
    const rows = attachments.listAllWithPaths(db, config)
    let done = 0
    let errors = 0
    let lastProgressAt = 0
    const publishProgress = (final = false) => {
      const now = Date.now()
      if (!final && now - lastProgressAt < 200) return
      lastProgressAt = now
      events.emit(channel, { done, total: rows.length })
    }
    publishProgress()
    for (const attachment of rows) {
      try {
        if (force) await thumbnails.regenerate(attachment, variant)
        else await thumbnails.generate(attachment, variant)
      } catch (error) {
        errors++
        console.warn(
          `[thumbnails] ${variant} warmup failed for ${attachment.file_path}: ${error.message}`
        )
      }
      done++
      publishProgress(done === rows.length)
    }
    return { started: true, queued: rows.length, done, errors }
  }

  async function pruneDerivatives(snapshots) {
    if (
      snapshots.some(
        (snapshot) => !snapshot.file_path || !fs.existsSync(snapshot.file_path)
      )
    ) {
      thumbnails?.clear?.()
      await (options.clearStreamableVideos || clearStreamableVideos)(
        options.cacheDirectory || path.dirname(databasePath)
      )
      return
    }
    for (const snapshot of snapshots) {
      thumbnails?.invalidate?.(snapshot)
      await (options.pruneStreamableVideo || pruneStreamableVideo)(
        options.cacheDirectory || path.dirname(databasePath),
        snapshot
      )
    }
  }

  const repositoryMethods = {
    "attachments:get": (database, id) => attachments.get(database, id, config),
    "attachments:list": (database, dayId, opts) =>
      attachments.list(database, dayId, opts, config),
    "attachments:list-all": (database, opts) =>
      attachments.listAll(database, opts, config),
    "attachments:list-for-range": (database, start, end, opts) =>
      attachments.listForRange(database, start, end, opts, config),
    "attachments:list-geo": (database, opts) =>
      attachments.listGeo(database, opts, config),
    "attachments:list-missing-date-time-original": (database, opts) =>
      attachments.listMissingDateTimeOriginal(database, opts, config),
    "attachments:list-no-gps": (database, opts) =>
      attachments.listNoGps(database, opts, config),
    "days:ensure": days.ensure,
    "days:get": days.get,
    "messages:list-folder-items": messages.listFolderItems,
    "messages:list-folders": messages.listFolders
  }

  return async function call(method, args = []) {
    if (typeof method !== "string" || !Array.isArray(args)) {
      throw new Error("Invalid RPC request")
    }

    if (custom[method]) {
      const result = await custom[method](...args)
      if (mutatingCustomMethods.has(method)) {
        events.emit("data-changed", { method })
      }
      return result
    }

    const fn = repositoryMethods[method]
    if (typeof fn !== "function")
      throw new Error(`Unsupported method: ${method}`)

    const result = await fn(db, ...args)
    return result
  }
}
