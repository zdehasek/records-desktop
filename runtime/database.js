import fs from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  CacheIntegrityError,
  IncompatibleCacheSchemaError,
  initializeSchema
} from "./src/db/init.js"
import { ensurePrivateDirectory, recordsCacheDirectory } from "./src/paths.js"

export function defaultDatabasePath() {
  if (process.env.RECORDS_DB_PATH) return process.env.RECORDS_DB_PATH
  return path.join(
    ensurePrivateDirectory(recordsCacheDirectory()),
    "index.sqlite3"
  )
}

function secureDatabaseFiles(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.chmodSync(`${databasePath}${suffix}`, 0o600)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

function openCacheDatabase(
  databasePath,
  {
    databaseFactory = (filePath, options) =>
      new DatabaseSync(filePath, options),
    initialize = initializeSchema
  } = {}
) {
  const existing = fs.existsSync(databasePath)
  const db = databaseFactory(databasePath, {
    enableForeignKeyConstraints: true
  })
  try {
    db.exec("PRAGMA busy_timeout = 30000")
    secureDatabaseFiles(databasePath)
    initialize(db, { existing })
    db.exec("PRAGMA journal_mode = WAL")
    secureDatabaseFiles(databasePath)
    return db
  } catch (error) {
    try {
      db.close()
    } catch {
      // Preserve the setup error; recovery classification depends on it.
    }
    throw error
  }
}

function removeCacheDatabase(databasePath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${databasePath}${suffix}`, { force: true })
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

export function openDatabase(databasePath = defaultDatabasePath(), options) {
  ensurePrivateDirectory(path.dirname(databasePath))
  let db
  try {
    db = openCacheDatabase(databasePath, options)
    return db
  } catch (error) {
    try {
      db?.close()
    } catch {
      // The cache is being discarded, so a failed close cannot preserve data.
    }
    if (!rebuildableCacheError(error)) throw error
    removeCacheDatabase(databasePath)
    try {
      return openCacheDatabase(databasePath, options)
    } catch (rebuildError) {
      rebuildError.cause ||= error
      throw rebuildError
    }
  }
}

export function openWorkerDatabase(databasePath) {
  const db = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true
  })
  try {
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA journal_mode = WAL")
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
