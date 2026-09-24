import { EventEmitter } from "node:events"
import { openWorkerDatabase } from "./database.js"
import {
  terminateActiveProcessTrees,
  terminateActiveProcessTreesSync
} from "./host-tools.js"
import { createImageCaptionMetadata } from "./src/services/image-caption-metadata.js"
import { createWatchScanner } from "./watch-scanner.js"

let db = null
let exiting = false

function send(message) {
  if (process.connected) process.send(message)
}

function closeDatabase() {
  if (!db) return
  db.close()
  db = null
}

async function shutdown() {
  if (exiting) return
  exiting = true
  await terminateActiveProcessTrees()
  closeDatabase()
  process.exit(0)
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (exiting) {
      terminateActiveProcessTreesSync()
      closeDatabase()
      process.exit(1)
    }
    void shutdown()
  })
}
process.on("disconnect", shutdown)
process.once("exit", () => {
  terminateActiveProcessTreesSync()
  closeDatabase()
})

process.once("message", async (request) => {
  try {
    db = openWorkerDatabase(request.databasePath)
    const events = new EventEmitter()
    let lastProgressAt = 0
    events.on("photos-import-progress", (data) => {
      const now = Date.now()
      if (!data.complete && now - lastProgressAt < 200) return
      lastProgressAt = now
      send({ type: "event", channel: "photos-import-progress", data })
    })
    events.on("data-changed", (data) => {
      send({ type: "event", channel: "data-changed", data })
    })
    const roots = request.roots || []
    const scanner = createWatchScanner(db, events, {
      config: { mediaRoots: () => roots },
      captionMetadata: createImageCaptionMetadata(),
      batchPauseMs: 50,
      onAttachmentChanged: (attachment) =>
        send({ type: "attachment-changed", attachment })
    })
    const result =
      request.operation === "replace-root"
        ? await scanner.replaceRoot(request.root, request.options)
        : await scanner.scan()
    closeDatabase()
    send({ type: "result", result })
    process.disconnect()
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`)
    closeDatabase()
    process.exitCode = 1
    process.disconnect()
  }
})
