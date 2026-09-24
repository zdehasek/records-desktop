import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import test from "node:test"
import {
  CacheIntegrityError,
  createCacheDb,
  IncompatibleCacheSchemaError,
  rebuildableCacheError
} from "../../runtime/src/services/cache/cache-db.js"
import {
  mediaCacheKey,
  mediaSourceId
} from "../../runtime/src/services/media-cache-key.js"
import {
  clearTileCache,
  closeTileCacheDb,
  getCachedTile,
  getTileCacheStats,
  MAX_TILE_BYTES,
  openTileCacheDb,
  putCachedTile,
  validateTileCoordinates
} from "../../runtime/src/services/cache/tile-cache.js"
import {
  clearThumbnails,
  closeThumbnailDb,
  deleteThumbnails,
  getThumbnail,
  openThumbnailDb,
  putThumbnail
} from "../../runtime/src/services/thumbnail/thumbnail-db.js"

function temporaryDirectory(context, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

test("tile cache supports unopened, populated, and cleared states", (context) => {
  closeTileCacheDb()
  assert.equal(getCachedTile(1, 1, 1), null)
  assert.deepEqual(getTileCacheStats(), { tileCount: 0, totalBytes: 0 })
  assert.doesNotThrow(() => putCachedTile(1, 1, 1, Buffer.from("ignored")))
  assert.doesNotThrow(() => clearTileCache())

  const directory = temporaryDirectory(context, "records-tile-cache-")
  openTileCacheDb(directory)
  putCachedTile(4, 5, 6, Buffer.from([1, 2, 3]))
  assert.deepEqual([...getCachedTile(4, 5, 6)], [1, 2, 3])
  assert.equal(getCachedTile(9, 9, 9), null)
  const populated = getTileCacheStats()
  assert.equal(populated.tileCount, 1)
  assert.ok(populated.totalBytes > 0)

  clearTileCache()
  assert.equal(getTileCacheStats().tileCount, 0)
  closeTileCacheDb()
})

test("tile cache validates input and evicts least-recently-used data", (context) => {
  const directory = temporaryDirectory(context, "records-tile-limits-")
  openTileCacheDb(directory)
  context.after(() => closeTileCacheDb())

  assert.throws(() => validateTileCoordinates(-1, 0, 0), /coordinates/)
  assert.throws(() => validateTileCoordinates(2, 4, 0), /coordinates/)
  assert.throws(
    () => putCachedTile(1, 0, 0, Buffer.alloc(MAX_TILE_BYTES + 1)),
    /tile data/
  )

  putCachedTile(2, 0, 0, Buffer.from([1, 2, 3]), 5)
  putCachedTile(2, 1, 0, Buffer.from([4, 5, 6]), 5)
  assert.equal(getCachedTile(2, 0, 0), null)
  assert.deepEqual([...getCachedTile(2, 1, 0)], [4, 5, 6])
})

test("cache database opens lazily, warms, closes, and reopens", async (context) => {
  const directory = temporaryDirectory(context, "records-cache-db-")
  const cache = createCacheDb({
    fileName: "test.sqlite3",
    schema: "CREATE TABLE IF NOT EXISTS values_table (value TEXT NOT NULL);",
    sanityQuery: "SELECT 1 FROM values_table LIMIT 1",
    logTag: "test-cache",
    applicationId: 101,
    schemaVersion: 1,
    prepareStatements: (db) => ({
      insert: db.prepare("INSERT INTO values_table (value) VALUES (?)"),
      list: db.prepare("SELECT value FROM values_table ORDER BY rowid")
    })
  })

  assert.equal(cache.getDb(), null)
  await cache.warmOpen()
  cache.open(directory)
  await cache.warmOpen()
  cache.eagerOpen()
  cache.getStmts().insert.run("one")
  assert.deepEqual(
    cache
      .getStmts()
      .list.all()
      .map((row) => row.value),
    ["one"]
  )
  await cache.warmOpen()
  cache.close()
  assert.equal(cache.getDb(), null)

  cache.open(directory)
  await cache.warmOpen()
  assert.deepEqual(
    cache
      .getStmts()
      .list.all()
      .map((row) => row.value),
    ["one"]
  )
  cache.close()
})

test("cache database recreates a corrupt file", (context) => {
  const directory = temporaryDirectory(context, "records-corrupt-cache-")
  const databasePath = path.join(directory, "corrupt.sqlite3")
  fs.writeFileSync(databasePath, "not a sqlite database")
  const cache = createCacheDb({
    fileName: path.basename(databasePath),
    schema: "CREATE TABLE IF NOT EXISTS recovered (id INTEGER PRIMARY KEY);",
    sanityQuery: "SELECT 1 FROM recovered LIMIT 1",
    logTag: "test-corrupt-cache",
    applicationId: 102,
    schemaVersion: 1,
    prepareStatements: (db) => ({
      count: db.prepare("SELECT COUNT(*) AS count FROM recovered")
    })
  })
  const originalConsoleError = console.error
  const errors = []
  console.error = (...args) => errors.push(args.join(" "))
  context.after(() => {
    console.error = originalConsoleError
    cache.close()
  })

  cache.open(directory)
  assert.equal(cache.getStmts().count.get().count, 0)
  assert.match(
    errors.join("\n"),
    /Database incompatible or corrupt, recreating/
  )
})

test("auxiliary cache rebuild classification is narrow", () => {
  assert.equal(
    rebuildableCacheError(new IncompatibleCacheSchemaError("schema")),
    true
  )
  assert.equal(
    rebuildableCacheError(new CacheIntegrityError("integrity")),
    true
  )
  for (const errcode of [11, 26, 11 | (3 << 8), 26 | (1 << 8)]) {
    assert.equal(
      rebuildableCacheError(
        Object.assign(new Error("sqlite"), {
          code: "ERR_SQLITE_ERROR",
          errcode
        })
      ),
      true
    )
  }
  for (const errcode of [1, 5, 6, 8, 10, 13, 14]) {
    assert.equal(
      rebuildableCacheError(
        Object.assign(new Error("operational"), {
          code: "ERR_SQLITE_ERROR",
          errcode
        })
      ),
      false
    )
  }
})

test("cache database rebuilds after a failed quick_check", (context) => {
  const directory = temporaryDirectory(context, "records-cache-integrity-")
  const databasePath = path.join(directory, "integrity.sqlite3")
  const original = new DatabaseSync(databasePath)
  original.exec(`
    CREATE TABLE values_table (value TEXT NOT NULL);
    INSERT INTO values_table VALUES ('discarded');
    PRAGMA application_id = 103;
    PRAGMA user_version = 1;
  `)
  original.close()
  let checks = 0
  const cache = createCacheDb({
    fileName: path.basename(databasePath),
    schema: "CREATE TABLE values_table (value TEXT NOT NULL);",
    sanityQuery: "SELECT 1 FROM values_table LIMIT 1",
    logTag: "test-integrity-cache",
    applicationId: 103,
    schemaVersion: 1,
    checkIntegrity() {
      checks += 1
      throw new CacheIntegrityError("injected quick_check failure")
    },
    prepareStatements: (db) => ({
      count: db.prepare("SELECT COUNT(*) AS count FROM values_table")
    })
  })
  context.after(() => cache.close())

  cache.open(directory)
  assert.equal(cache.getStmts().count.get().count, 0)
  assert.equal(checks, 1)
})

test("cache database preserves its family for operational errors", async (context) => {
  const cases = [
    ["busy", "ERR_SQLITE_ERROR", 5],
    ["locked", "ERR_SQLITE_ERROR", 6],
    ["read-only", "ERR_SQLITE_ERROR", 8],
    ["I/O", "ERR_SQLITE_ERROR", 10 | (2 << 8)],
    ["full", "ERR_SQLITE_ERROR", 13],
    ["cannot open", "ERR_SQLITE_ERROR", 14],
    ["permission", "EACCES", undefined]
  ]
  for (const [name, code, errcode] of cases) {
    await context.test(name, (subcontext) => {
      const directory = temporaryDirectory(
        subcontext,
        "records-cache-preserve-"
      )
      const databasePath = path.join(directory, "preserve.sqlite3")
      const expected = new Map([
        [databasePath, Buffer.from("cache-database")],
        [`${databasePath}-wal`, Buffer.from("cache-wal")],
        [`${databasePath}-shm`, Buffer.from("cache-shm")]
      ])
      for (const [filePath, bytes] of expected)
        fs.writeFileSync(filePath, bytes)
      const operationalError = Object.assign(new Error(name), {
        code,
        ...(errcode === undefined ? {} : { errcode })
      })
      const cache = createCacheDb({
        fileName: path.basename(databasePath),
        schema: "CREATE TABLE values_table (value TEXT NOT NULL);",
        sanityQuery: "SELECT 1 FROM values_table LIMIT 1",
        logTag: "test-preserve-cache",
        applicationId: 104,
        schemaVersion: 1,
        databaseFactory() {
          throw operationalError
        },
        prepareStatements: () => ({})
      })
      subcontext.after(() => cache.close())
      const originalConsoleError = console.error
      const errors = []
      console.error = (...args) => errors.push(args)
      try {
        cache.open(directory)
        assert.throws(
          () => cache.getDb(),
          (error) => error === operationalError
        )
      } finally {
        console.error = originalConsoleError
      }
      assert.deepEqual(errors, [])
      for (const [filePath, bytes] of expected) {
        assert.deepEqual(fs.readFileSync(filePath), bytes)
      }
    })
  }
})

test("media cache keys separate paths and revisions without using row IDs", (context) => {
  const directory = temporaryDirectory(context, "records-media-key-")
  const firstPath = path.join(directory, "first.jpg")
  const secondPath = path.join(directory, "second.jpg")
  fs.writeFileSync(firstPath, "same")
  fs.writeFileSync(secondPath, "same")
  const timestamp = new Date(1_700_000_000_000)
  fs.utimesSync(firstPath, timestamp, timestamp)
  fs.utimesSync(secondPath, timestamp, timestamp)

  const first = mediaCacheKey({ filePath: firstPath, relativePath: "same.jpg" })
  const second = mediaCacheKey({
    filePath: secondPath,
    relativePath: "same.jpg"
  })
  assert.notEqual(first.sourceId, second.sourceId)
  assert.equal(
    mediaSourceId({ filePath: firstPath, relativePath: "same.jpg" }),
    first.sourceId
  )

  const replacement = path.join(directory, "replacement.jpg")
  fs.writeFileSync(replacement, "same")
  fs.utimesSync(replacement, timestamp, timestamp)
  fs.renameSync(replacement, firstPath)
  const replaced = mediaCacheKey({
    filePath: firstPath,
    relativePath: "same.jpg"
  })
  assert.equal(replaced.sourceId, first.sourceId)
  assert.notEqual(replaced.sourceRevision, first.sourceRevision)
})

test("thumbnail cache keys by source revision and supports prune and clear", (context) => {
  closeThumbnailDb()
  const directory = temporaryDirectory(context, "records-thumbnail-db-")
  context.after(() => closeThumbnailDb())
  openThumbnailDb(directory)

  putThumbnail("source-a", "revision-1", "thumb", Buffer.from("old"))
  putThumbnail("source-b", "revision-1", "thumb", Buffer.from("other"))
  assert.equal(
    getThumbnail("source-a", "revision-1", "thumb").toString(),
    "old"
  )
  assert.equal(getThumbnail("source-a", "revision-2", "thumb"), null)

  putThumbnail("source-a", "revision-2", "thumb", Buffer.from("new"))
  assert.equal(getThumbnail("source-a", "revision-1", "thumb"), null)
  assert.equal(
    getThumbnail("source-a", "revision-2", "thumb").toString(),
    "new"
  )
  deleteThumbnails("source-a")
  assert.equal(getThumbnail("source-a", "revision-2", "thumb"), null)
  assert.ok(getThumbnail("source-b", "revision-1", "thumb"))
  clearThumbnails()
  assert.equal(getThumbnail("source-b", "revision-1", "thumb"), null)
})

test("thumbnail cache recreates the attachment-ID schema", (context) => {
  closeThumbnailDb()
  const directory = temporaryDirectory(context, "records-thumbnail-schema-")
  const databasePath = path.join(directory, "thumbnails.sqlite3")
  const legacy = new DatabaseSync(databasePath)
  legacy.exec(`
    CREATE TABLE thumbnails (
      attachment_id INTEGER NOT NULL,
      variant TEXT NOT NULL,
      data BLOB NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (attachment_id, variant)
    );
    PRAGMA application_id = 1380273485;
    PRAGMA user_version = 1;
  `)
  legacy.close()
  context.after(() => closeThumbnailDb())

  openThumbnailDb(directory)
  assert.equal(getThumbnail("source", "revision", "thumb"), null)
  putThumbnail("source", "revision", "thumb", Buffer.from("fresh"))
  assert.equal(getThumbnail("source", "revision", "thumb").toString(), "fresh")
})
