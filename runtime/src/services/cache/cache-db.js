import "../../suppress-sqlite-warning.js"
import { DatabaseSync } from "node:sqlite"
import { Worker } from "worker_threads"
import path from "path"
import fs from "fs"

export class IncompatibleCacheSchemaError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = "IncompatibleCacheSchemaError"
  }
}

export class CacheIntegrityError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = "CacheIntegrityError"
  }
}

function verifyIntegrity(database) {
  const results = database.prepare("PRAGMA quick_check").all()
  if (
    results.length !== 1 ||
    (results[0].quick_check ?? Object.values(results[0])[0]) !== "ok"
  ) {
    throw new CacheIntegrityError("Cache database integrity check failed")
  }
}

export function rebuildableCacheError(error) {
  if (
    error instanceof IncompatibleCacheSchemaError ||
    error instanceof CacheIntegrityError
  ) {
    return true
  }
  if (error?.code !== "ERR_SQLITE_ERROR") return false
  return [11, 26].includes(error.errcode & 0xff)
}

/**
 * Factory that creates open/close helpers for a SQLite cache database.
 * Both thumbnail-db and tile-cache share the same open → probe → recover
 * pattern, differing only in file name, schema, sanity query, log tag,
 * and the set of prepared statements.
 *
 * Opening is deferred (lazy) — calling `open(dataDir)` merely records the
 * directory; the actual SQLite file is not opened until the first call to
 * `getDb()` or `getStmts()`.  This avoids blocking the main thread at
 * startup when cache databases are large (515 MB thumbnails, 4.7 GB tiles).
 *
 * @param {object} opts
 * @param {string} opts.fileName        - e.g. "thumbnails.sqlite3"
 * @param {string} opts.schema          - CREATE TABLE … DDL
 * @param {string} opts.sanityQuery     - lightweight SELECT to detect corruption
 * @param {string} opts.logTag          - e.g. "thumb-db"
 * @param {number} opts.applicationId   - SQLite application identifier
 * @param {number} opts.schemaVersion   - Destructive cache schema version
 * @param {(db: DatabaseSync) => object} opts.prepareStatements
 *   Called after schema is applied. Must return an object of prepared statements.
 *
 * @returns {{ open: (dataDir: string) => void, close: () => void, getDb: () => DatabaseSync|null, getStmts: () => object|null }}
 */
export function createCacheDb({
  fileName,
  schema,
  sanityQuery,
  logTag,
  applicationId,
  schemaVersion,
  prepareStatements,
  databaseFactory = (filePath, options = {}) =>
    new DatabaseSync(filePath, options),
  checkIntegrity = verifyIntegrity
}) {
  let db = null
  let stmts = null
  let pendingDataDir = null

  function initialize(database, existing) {
    if (existing) checkIntegrity(database)
    const objects = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1"
      )
      .get()
    const currentApplicationId = database
      .prepare("PRAGMA application_id")
      .get().application_id
    const currentVersion = database
      .prepare("PRAGMA user_version")
      .get().user_version
    if (!objects) {
      if (currentApplicationId !== 0 || currentVersion !== 0) {
        throw new IncompatibleCacheSchemaError(
          `incompatible marker-only cache schema ${currentApplicationId}/${currentVersion}`
        )
      }
      database.exec(schema)
      database.exec(`PRAGMA application_id = ${applicationId}`)
      database.exec(`PRAGMA user_version = ${schemaVersion}`)
    } else if (
      currentApplicationId !== applicationId ||
      currentVersion !== schemaVersion
    ) {
      throw new IncompatibleCacheSchemaError(
        `incompatible cache schema ${currentApplicationId}/${currentVersion}`
      )
    }
    let prepared
    try {
      database.prepare(sanityQuery).get()
      prepared = prepareStatements(database)
    } catch (error) {
      if (error?.code !== "ERR_SQLITE_ERROR" || (error.errcode & 0xff) !== 1) {
        throw error
      }
      throw new IncompatibleCacheSchemaError(
        "incompatible cache table or index definition",
        { cause: error }
      )
    }
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = NORMAL")
    return prepared
  }

  function removeDatabase(dbPath) {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(dbPath + suffix)
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
    }
  }

  function openNow() {
    if (!pendingDataDir) return
    const dataDir = pendingDataDir
    const dbPath = path.join(dataDir, fileName)
    const existing = fs.existsSync(dbPath)

    try {
      db = databaseFactory(dbPath)
      stmts = initialize(db, existing)
    } catch (err) {
      try {
        db?.close()
      } catch {
        // ignore
      }
      db = null
      if (!rebuildableCacheError(err)) throw err
      console.error(
        `[${logTag}] Database incompatible or corrupt, recreating:`,
        err.message
      )
      removeDatabase(dbPath)
      db = databaseFactory(dbPath)
      try {
        stmts = initialize(db, false)
      } catch (rebuildError) {
        try {
          db.close()
        } catch {
          // Preserve the rebuild error.
        }
        db = null
        rebuildError.cause ||= err
        throw rebuildError
      }
    }
  }

  /**
   * Register the data directory for this cache. The actual SQLite file is
   * not opened until the first `getDb()` or `getStmts()` call (lazy).
   */
  function open(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dataDir, 0o700)
    pendingDataDir = dataDir
  }

  function close() {
    try {
      db?.close()
    } catch {
      // ignore
    }
    db = null
    stmts = null
    pendingDataDir = null
  }

  function getDb() {
    if (!db && pendingDataDir) openNow()
    return db
  }

  function getStmts() {
    if (!stmts && pendingDataDir) openNow()
    return stmts
  }

  /**
   * Force the deferred open to happen now (synchronous).
   */
  function eagerOpen() {
    if (!db && pendingDataDir) openNow()
  }

  /**
   * Warm the OS page cache by opening the database in a worker thread,
   * running pragmas + schema, then closing it. This is fully async — the
   * main thread stays free. After the promise resolves, the subsequent
   * synchronous `openNow()` (via `getDb()`) is fast because the kernel
   * already has the file pages cached.
   *
   * If the DB is already open, resolves immediately.
   */
  function warmOpen() {
    if (db || !pendingDataDir) return Promise.resolve()

    const dbPath = path.join(pendingDataDir, fileName)
    if (!fs.existsSync(dbPath)) return Promise.resolve()

    return new Promise((resolve) => {
      const workerCode = `
        const { parentPort, workerData } = require("worker_threads")
        try {
          const { DatabaseSync } = require("node:sqlite")
          const db = new DatabaseSync(workerData.dbPath, { readOnly: true })
          db.prepare(workerData.sanityQuery).get()
          db.close()
          parentPort.postMessage({ ok: true })
        } catch (err) {
          // Non-fatal — the main-thread open will handle corruption recovery
          parentPort.postMessage({ ok: false, error: err.message })
        }
      `

      const worker = new Worker(workerCode, {
        eval: true,
        workerData: { dbPath, sanityQuery }
      })

      worker.on("message", (msg) => {
        if (!msg.ok) {
          console.error(
            `[${logTag}] warmOpen worker error (non-fatal):`,
            msg.error
          )
        }
        resolve()
      })

      worker.on("error", (err) => {
        console.error(`[${logTag}] warmOpen worker failed (non-fatal):`, err)
        resolve() // Non-fatal — lazy open will still work
      })
    })
  }

  return { open, close, getDb, getStmts, eagerOpen, warmOpen }
}
