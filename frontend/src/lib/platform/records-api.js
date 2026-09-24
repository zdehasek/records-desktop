import { recordsCapabilities } from "./capabilities.js"

const namespaces = {
  attachments: {
    get: "get",
    list: "list",
    listAll: "list-all",
    listDuplicateGroups: "list-duplicate-groups",
    listForRange: "list-for-range",
    listGeo: "list-geo",
    listMissingDateTimeOriginal: "list-missing-date-time-original",
    listMissingImported: "list-missing-imported",
    listNoGps: "list-no-gps",
    pickAndAdd: "pick-and-add",
    purgeMissingImported: "purge-missing-imported",
    open: "open",
    setDuplicateCanonical: "set-duplicate-canonical",
    showInFolder: "show-in-folder",
    update: "update",
    writeGpsToFile: "write-gps-to-file"
  },
  days: {
    ensure: "ensure",
    get: "get",
    listForRange: "list-for-range",
    listWithContent: "list-with-content",
    memory: "memory",
    storyItems: "story-items"
  },
  mapTiles: { clear: "clear", get: "get", put: "put", stats: "stats" },
  messages: {
    batchDelete: "batch-delete",
    batchSetVisibility: "batch-set-visibility",
    delete: "delete",
    list: "list",
    listFolderItems: "list-folder-items",
    listFolders: "list-folders",
    renameFolder: "rename-folder",
    setVisibility: "set-visibility"
  },
  photos: { createGif: "create-gif" },
  profiles: {
    create: "create",
    list: "list",
    switch: "switch"
  },
  settings: { all: "all", set: "set" },
  mediaFolders: {
    add: "add",
    list: "list",
    remove: "remove",
    setDefault: "set-default",
    toggle: "toggle"
  },
  system: { capabilities: "capabilities" },
  thumbnails: {
    regenerate: "regenerate",
    regenerateAll: "regenerate-all",
    warmup: "warmup",
    warmupMicro: "warmup-micro"
  }
}

const listeners = new Map()
let eventSource = null

async function invoke(method, ...args) {
  const response = await fetch(new URL("rpc", document.baseURI), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args })
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `RPC failed: ${method}`)
  return payload.result
}

function bind(namespace, methods) {
  return Object.fromEntries(
    Object.entries(methods).map(([name, action]) => [
      name,
      (...args) => invoke(`${kebabCase(namespace)}:${action}`, ...args)
    ])
  )
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

function mediaUrl(id, variant = "") {
  const suffix = variant ? `/${variant}` : ""
  return new URL(`media/${id}${suffix}`, document.baseURI).href
}

function subscribe(channel, callback, withData = false) {
  if (!eventSource) {
    eventSource = new EventSource(new URL("events", document.baseURI))
  }
  if (!listeners.has(channel)) {
    listeners.set(channel, new Set())
    eventSource.addEventListener(channel, (event) => {
      const data = JSON.parse(event.data)
      for (const current of listeners.get(channel) || []) current(data)
    })
  }
  const listener = (data) => callback(withData ? data : undefined)
  listeners.get(channel).add(listener)
  return () => listeners.get(channel)?.delete(listener)
}

export function createRecordsApi() {
  const api = Object.fromEntries(
    Object.entries(namespaces).map(([namespace, methods]) => [
      namespace,
      bind(namespace, methods)
    ])
  )

  Object.assign(api.attachments, {
    url: (id) => mediaUrl(id),
    thumbnailUrl: (id) => mediaUrl(id, "thumb"),
    microThumbnailUrl: (id) => mediaUrl(id, "micro"),
    yearThumbnailUrl: (id) => mediaUrl(id, "year"),
    streamableUrl: async (id, options = {}) =>
      `${mediaUrl(id, "stream")}${options.force ? "?force=1" : ""}`
  })
  api.on = {
    photosImported: (callback) => subscribe("data-changed", callback),
    photosImportProgress: (callback) =>
      subscribe("photos-import-progress", callback, true),
    thumbnailsMicroProgress: (callback) =>
      subscribe("thumbnails-micro-progress", callback, true),
    thumbnailsProgress: (callback) =>
      subscribe("thumbnails-progress", callback, true)
  }
  api.platform = { kind: "omarchy" }
  api.capabilities = recordsCapabilities
  api.version = () => globalThis.__RECORDS_VERSION__
  api.log = (level, tag, message, ...args) => {
    const fn = console[level] || console.log
    fn(`[${tag}]`, message, ...args)
  }
  api.toggleDevTools = () => {}
  return api
}
