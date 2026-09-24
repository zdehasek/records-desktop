import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import "../../runtime/src/suppress-sqlite-warning.js"
import { DatabaseSync } from "node:sqlite"
import { openDatabase, rebuildableCacheError } from "../../runtime/database.js"
import {
  APPLICATION_ID,
  CacheIntegrityError,
  IncompatibleCacheSchemaError,
  initializeSchema,
  SCHEMA_VERSION
} from "../../runtime/src/db/init.js"
import { runTransaction } from "../../runtime/src/db/transaction.js"

test("SQLite experimental warnings are suppressed", () => {
  assert.doesNotThrow(() => process.emitWarning("SQLite is experimental"))
  assert.doesNotThrow(() =>
    process.emitWarning({ message: "SQLite object warning" })
  )
})

const open = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "records-db-test-"))
  const db = new DatabaseSync(path.join(directory, "records.sqlite3"))
  return {
    db,
    close() {
      db.close()
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
}

const userObjects = (db) =>
  db
    .prepare(
      "SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    )
    .all()
    .map((row) => ({ ...row }))

test("initializeSchema creates only the versioned attachments cache", () => {
  const fixture = open()
  try {
    initializeSchema(fixture.db)
    initializeSchema(fixture.db)
    assert.deepEqual(userObjects(fixture.db), [
      { type: "index", name: "idx_attachments_created" },
      { type: "index", name: "idx_attachments_fingerprint" },
      { type: "index", name: "idx_attachments_mime_created" },
      { type: "table", name: "attachments" }
    ])
    assert.deepEqual(
      fixture.db
        .prepare("PRAGMA table_info('attachments')")
        .all()
        .map((row) => row.name),
      [
        "id",
        "root_name",
        "relative_path",
        "mime_type",
        "byte_size",
        "mtime_ms",
        "content",
        "duration_seconds",
        "important",
        "note_color",
        "content_fingerprint",
        "exif_data",
        "source_revision",
        "created_at"
      ]
    )
    assert.equal(
      fixture.db.prepare("PRAGMA application_id").get().application_id,
      APPLICATION_ID
    )
    assert.equal(
      fixture.db.prepare("PRAGMA user_version").get().user_version,
      SCHEMA_VERSION
    )
    assert.deepEqual(
      fixture.db
        .prepare("PRAGMA index_info('sqlite_autoindex_attachments_1')")
        .all()
        .map((row) => row.name),
      ["root_name", "relative_path"]
    )
  } finally {
    fixture.close()
  }
})

test("initializeSchema rejects an incompatible cache shape", () => {
  const fixture = open()
  try {
    fixture.db.exec(`
      CREATE TABLE attachments(id INTEGER PRIMARY KEY);
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = ${SCHEMA_VERSION};
    `)
    assert.throws(
      () => initializeSchema(fixture.db),
      IncompatibleCacheSchemaError
    )
  } finally {
    fixture.close()
  }
})

test("initializeSchema rejects marker-only databases with nonzero markers", () => {
  for (const [applicationId, version] of [
    [APPLICATION_ID, 0],
    [999, SCHEMA_VERSION],
    [0, SCHEMA_VERSION]
  ]) {
    const fixture = open()
    try {
      fixture.db.exec(`
        PRAGMA application_id = ${applicationId};
        PRAGMA user_version = ${version};
      `)
      assert.throws(
        () => initializeSchema(fixture.db),
        IncompatibleCacheSchemaError
      )
      assert.deepEqual(userObjects(fixture.db), [])
    } finally {
      fixture.close()
    }
  }
})

test("main cache rebuild classification is narrow", () => {
  assert.equal(
    rebuildableCacheError(new IncompatibleCacheSchemaError("schema")),
    true
  )
  assert.equal(
    rebuildableCacheError(new CacheIntegrityError("integrity")),
    true
  )
  for (const errcode of [11, 26, 11 | (2 << 8), 26 | (1 << 8)]) {
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
  assert.equal(
    rebuildableCacheError(
      Object.assign(new Error("permission"), { code: "EACCES" })
    ),
    false
  )
})

test("initializeSchema rejects schema and index definition tampering", async (context) => {
  const cases = [
    {
      name: "changed constraint",
      tamper(db) {
        db.exec(`
          CREATE TABLE attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            root_name TEXT NOT NULL,
            relative_path TEXT NOT NULL,
            mime_type TEXT NOT NULL CHECK(
              mime_type GLOB 'image/?*' OR
              mime_type GLOB 'video/?*' OR
              mime_type GLOB 'audio/?*'
            ),
            byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
            mtime_ms REAL NOT NULL CHECK(mtime_ms >= 0),
            content TEXT NOT NULL DEFAULT '',
            duration_seconds REAL CHECK(duration_seconds >= 0 AND duration_seconds < 1.0e308),
            important INTEGER NOT NULL DEFAULT 0 CHECK(important IN (0, 1)),
            note_color TEXT CHECK(note_color IN ('white', 'butter', 'blush', 'mint', 'sky', 'lavender')),
            content_fingerprint TEXT,
            exif_data TEXT CHECK(exif_data IS NULL OR (json_valid(exif_data) AND json_type(exif_data) = 'object')),
            source_revision TEXT,
            created_at TEXT NOT NULL,
            UNIQUE(root_name, relative_path)
          );
          CREATE INDEX idx_attachments_created ON attachments(created_at);
          CREATE INDEX idx_attachments_mime_created ON attachments(mime_type, created_at);
          CREATE INDEX idx_attachments_fingerprint ON attachments(content_fingerprint)
            WHERE content_fingerprint IS NOT NULL;
        `)
      }
    },
    {
      name: "changed partial index",
      tamper(db) {
        initializeSchema(db)
        db.exec(`
          DROP INDEX idx_attachments_fingerprint;
          CREATE INDEX idx_attachments_fingerprint ON attachments(content_fingerprint);
        `)
      }
    },
    {
      name: "extra trigger",
      tamper(db) {
        initializeSchema(db)
        db.exec(`
          CREATE TRIGGER attachments_tampered AFTER INSERT ON attachments BEGIN
            SELECT 1;
          END;
        `)
      }
    }
  ]
  for (const item of cases) {
    await context.test(item.name, () => {
      const fixture = open()
      try {
        item.tamper(fixture.db)
        fixture.db.exec(`
          PRAGMA application_id = ${APPLICATION_ID};
          PRAGMA user_version = ${SCHEMA_VERSION};
        `)
        assert.throws(
          () => initializeSchema(fixture.db),
          IncompatibleCacheSchemaError
        )
      } finally {
        fixture.close()
      }
    })
  }
})

test("attachments schema rejects non-media and invalid projections", () => {
  const fixture = open()
  try {
    initializeSchema(fixture.db)
    const insert = fixture.db.prepare(
      `INSERT INTO attachments
       (root_name, relative_path, mime_type, byte_size, mtime_ms,
         duration_seconds, important, note_color, exif_data,
         created_at)
       VALUES ('records', ?, ?, 1, 1, ?, ?, ?, ?, '2026-09-03T10:00:00Z')`
    )
    for (const values of [
      ["text.md", "text/plain", null, 0, null, null],
      ["empty-image", "image/", null, 0, null, null],
      ["empty-video", "video/", null, 0, null, null],
      ["audio-only.m4a", "audio/mp4", null, 0, null, null],
      ["negative.mp4", "video/mp4", -1, 0, null, null],
      ["infinite.mp4", "video/mp4", Number.POSITIVE_INFINITY, 0, null, null],
      ["boolean.mp4", "video/mp4", null, 2, null, null],
      ["color.mp4", "video/mp4", null, 0, "orange", null],
      ["exif.jpg", "image/jpeg", null, 0, null, "[]"]
    ]) {
      assert.throws(() => insert.run(...values), /constraint/i)
    }
    assert.equal(
      fixture.db.prepare("SELECT COUNT(*) AS count FROM attachments").get()
        .count,
      0
    )
  } finally {
    fixture.close()
  }
})

test("openDatabase rebuilds every representative incompatible disposable cache", async (context) => {
  for (const legacyVersion of [1, 2, SCHEMA_VERSION + 1]) {
    await context.test(`schema version ${legacyVersion}`, (subcontext) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "records-db-rebuild-")
      )
      const databasePath = path.join(directory, "index.sqlite3")
      subcontext.after(() =>
        fs.rmSync(directory, { recursive: true, force: true })
      )
      const old = new DatabaseSync(databasePath)
      old.exec(`
        CREATE TABLE legacy_history(value TEXT);
        PRAGMA application_id = ${APPLICATION_ID};
        PRAGMA user_version = ${legacyVersion};
      `)
      old
        .prepare("INSERT INTO legacy_history VALUES (?)")
        .run("must be discarded")
      old.close()
      const thumbnailPath = path.join(
        directory,
        "thumbnails",
        "thumbnails.sqlite3"
      )
      fs.mkdirSync(path.dirname(thumbnailPath))
      fs.writeFileSync(thumbnailPath, "stale thumbnail ids")
      const tilePath = path.join(directory, "tiles.sqlite3")
      fs.writeFileSync(tilePath, "independent tile cache")

      const db = openDatabase(databasePath)
      subcontext.after(() => db.close())
      assert.equal(
        db.prepare("PRAGMA application_id").get().application_id,
        APPLICATION_ID
      )
      assert.equal(
        db.prepare("PRAGMA user_version").get().user_version,
        SCHEMA_VERSION
      )
      assert.deepEqual(
        userObjects(db).filter((object) => object.type === "table"),
        [{ type: "table", name: "attachments" }]
      )
      assert.equal(
        fs.readFileSync(thumbnailPath, "utf8"),
        "stale thumbnail ids"
      )
      assert.equal(fs.readFileSync(tilePath, "utf8"), "independent tile cache")
    })
  }
})

test("openDatabase rebuilds a corrupt disposable cache", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-db-corrupt-")
  )
  const databasePath = path.join(directory, "index.sqlite3")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(databasePath, "not sqlite")

  const db = openDatabase(databasePath)
  context.after(() => db.close())
  assert.equal(
    db.prepare("PRAGMA application_id").get().application_id,
    APPLICATION_ID
  )
  assert.equal(
    db.prepare("PRAGMA user_version").get().user_version,
    SCHEMA_VERSION
  )
  assert.deepEqual(
    userObjects(db).filter((object) => object.type === "table"),
    [{ type: "table", name: "attachments" }]
  )
})

test("openDatabase rebuilds after a failed quick_check", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-db-integrity-")
  )
  const databasePath = path.join(directory, "index.sqlite3")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const original = new DatabaseSync(databasePath)
  initializeSchema(original)
  original.close()
  let checks = 0

  const db = openDatabase(databasePath, {
    initialize(database, options) {
      initializeSchema(database, {
        ...options,
        checkIntegrity() {
          checks += 1
          throw new CacheIntegrityError("injected quick_check failure")
        }
      })
    }
  })
  context.after(() => db.close())
  assert.equal(checks, 1)
  assert.deepEqual(
    userObjects(db).filter((object) => object.type === "table"),
    [{ type: "table", name: "attachments" }]
  )
})

test("openDatabase rebuilds an incompatible marker-only database", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-db-marker-only-")
  )
  const databasePath = path.join(directory, "index.sqlite3")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const marker = new DatabaseSync(databasePath)
  marker.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  marker.close()

  const db = openDatabase(databasePath)
  context.after(() => db.close())
  assert.deepEqual(
    userObjects(db).filter((object) => object.type === "table"),
    [{ type: "table", name: "attachments" }]
  )
})

test("openDatabase preserves paths on operational setup errors", (context) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "records-db-operational-")
  )
  const databasePath = path.join(directory, "index.sqlite3")
  const markerPath = path.join(databasePath, "keep")
  fs.mkdirSync(databasePath)
  fs.writeFileSync(markerPath, "original")
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  assert.throws(
    () => openDatabase(databasePath),
    (error) => error.code === "ERR_SQLITE_ERROR" && error.errcode === 14
  )
  assert.equal(fs.readFileSync(markerPath, "utf8"), "original")
})

test("openDatabase preserves the database family for operational errors", async (context) => {
  const cases = [
    ["busy", "ERR_SQLITE_ERROR", 5],
    ["locked", "ERR_SQLITE_ERROR", 6],
    ["read-only", "ERR_SQLITE_ERROR", 8],
    ["I/O", "ERR_SQLITE_ERROR", 10 | (1 << 8)],
    ["full", "ERR_SQLITE_ERROR", 13],
    ["cannot open", "ERR_SQLITE_ERROR", 14],
    ["permission", "EACCES", undefined]
  ]
  for (const [name, code, errcode] of cases) {
    await context.test(name, (subcontext) => {
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "records-db-preserve-")
      )
      subcontext.after(() =>
        fs.rmSync(directory, { recursive: true, force: true })
      )
      const databasePath = path.join(directory, "index.sqlite3")
      const expected = new Map([
        [databasePath, Buffer.from("database-family")],
        [`${databasePath}-wal`, Buffer.from("wal-family")],
        [`${databasePath}-shm`, Buffer.from("shm-family")]
      ])
      for (const [filePath, bytes] of expected)
        fs.writeFileSync(filePath, bytes)
      const operationalError = Object.assign(new Error(name), {
        code,
        ...(errcode === undefined ? {} : { errcode })
      })

      assert.throws(
        () =>
          openDatabase(databasePath, {
            databaseFactory() {
              throw operationalError
            }
          }),
        (error) => error === operationalError
      )
      for (const [filePath, bytes] of expected) {
        assert.deepEqual(fs.readFileSync(filePath), bytes)
      }
    })
  }
})

test("runTransaction commits values and rolls back failures", () => {
  const fixture = open()
  try {
    fixture.db.exec("CREATE TABLE values_test(value TEXT)")
    const result = runTransaction(fixture.db, () => {
      fixture.db.prepare("INSERT INTO values_test VALUES (?)").run("kept")
      return 42
    })
    assert.equal(result, 42)
    assert.throws(
      () =>
        runTransaction(fixture.db, () => {
          fixture.db.prepare("INSERT INTO values_test VALUES (?)").run("lost")
          throw new Error("stop")
        }),
      /stop/
    )
    assert.deepEqual(
      fixture.db
        .prepare("SELECT value FROM values_test")
        .all()
        .map((row) => row.value),
      ["kept"]
    )
  } finally {
    fixture.close()
  }
})
