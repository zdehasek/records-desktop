import fs from "node:fs"
import path from "node:path"

export const APPLICATION_ID = 1380270916
export const SCHEMA_VERSION = 3
const schemaPath = path.join(import.meta.dirname, "schema.sql")
const SCHEMA_SQL = fs.readFileSync(schemaPath, "utf8")

const EXPECTED_COLUMNS = [
  ["id", "INTEGER", 0, null, 1, 0],
  ["root_name", "TEXT", 1, null, 0, 0],
  ["relative_path", "TEXT", 1, null, 0, 0],
  ["mime_type", "TEXT", 1, null, 0, 0],
  ["byte_size", "INTEGER", 1, null, 0, 0],
  ["mtime_ms", "REAL", 1, null, 0, 0],
  ["content", "TEXT", 1, "''", 0, 0],
  ["duration_seconds", "REAL", 0, null, 0, 0],
  ["important", "INTEGER", 1, "0", 0, 0],
  ["note_color", "TEXT", 0, null, 0, 0],
  ["content_fingerprint", "TEXT", 0, null, 0, 0],
  ["exif_data", "TEXT", 0, null, 0, 0],
  ["source_revision", "TEXT", 0, null, 0, 0],
  ["created_at", "TEXT", 1, null, 0, 0]
]
const EXPECTED_OBJECTS = [
  { type: "index", name: "idx_attachments_created" },
  { type: "index", name: "idx_attachments_fingerprint" },
  { type: "index", name: "idx_attachments_mime_created" },
  { type: "table", name: "attachments" }
]
const EXPECTED_INDEXES = [
  ["idx_attachments_fingerprint", 0, "c", 1],
  ["idx_attachments_mime_created", 0, "c", 0],
  ["idx_attachments_created", 0, "c", 0],
  ["sqlite_autoindex_attachments_1", 1, "u", 0]
]
const EXPECTED_INDEX_COLUMNS = new Map([
  ["idx_attachments_created", ["created_at"]],
  ["idx_attachments_fingerprint", ["content_fingerprint"]],
  ["idx_attachments_mime_created", ["mime_type", "created_at"]],
  ["sqlite_autoindex_attachments_1", ["root_name", "relative_path"]]
])
const EXPECTED_SQL = new Map(
  [...SCHEMA_SQL.matchAll(/CREATE (?:TABLE|INDEX)\s+(\w+)[\s\S]*?;/g)].map(
    ([statement, name]) => [name, statement.slice(0, -1)]
  )
)

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

const normalizeSql = (sql) => sql.replace(/\s+/g, " ").trim()

function userObjects(db) {
  return db
    .prepare(
      `SELECT type, name FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all()
}

function verifySchema(db) {
  if (JSON.stringify(userObjects(db)) !== JSON.stringify(EXPECTED_OBJECTS)) {
    throw new IncompatibleCacheSchemaError("Unexpected Records cache objects")
  }
  const columns = db
    .prepare("PRAGMA table_info('attachments')")
    .all()
    .map((row) => [
      row.name,
      row.type,
      row.notnull,
      row.dflt_value,
      row.pk,
      row.hidden ?? 0
    ])
  if (JSON.stringify(columns) !== JSON.stringify(EXPECTED_COLUMNS)) {
    throw new IncompatibleCacheSchemaError("Unexpected Records cache columns")
  }
  const definitions = db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .all()
  if (
    definitions.some(
      ({ name, sql }) =>
        normalizeSql(sql) !== normalizeSql(EXPECTED_SQL.get(name))
    )
  ) {
    throw new IncompatibleCacheSchemaError(
      "Unexpected Records cache definition"
    )
  }
  const indexes = db
    .prepare("PRAGMA index_list('attachments')")
    .all()
    .map((row) => [row.name, row.unique, row.origin, row.partial])
  if (JSON.stringify(indexes) !== JSON.stringify(EXPECTED_INDEXES)) {
    throw new IncompatibleCacheSchemaError("Unexpected Records cache indexes")
  }
  for (const [name, expected] of EXPECTED_INDEX_COLUMNS) {
    const actual = db
      .prepare(`PRAGMA index_info('${name}')`)
      .all()
      .map((row) => row.name)
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new IncompatibleCacheSchemaError(`Unexpected Records index ${name}`)
    }
  }
  db.prepare(
    `SELECT id, root_name, relative_path, mime_type, byte_size, mtime_ms,
             content, duration_seconds, important, note_color,
             content_fingerprint, exif_data, source_revision, created_at
       FROM attachments LIMIT 0`
  ).all()
}

export function verifyIntegrity(db) {
  const results = db.prepare("PRAGMA quick_check").all()
  if (
    results.length !== 1 ||
    (results[0].quick_check ?? Object.values(results[0])[0]) !== "ok"
  ) {
    throw new CacheIntegrityError("Records cache integrity check failed")
  }
}

export function initializeSchema(
  db,
  { existing = false, checkIntegrity = verifyIntegrity } = {}
) {
  const objects = userObjects(db)
  const applicationId = db.prepare("PRAGMA application_id").get().application_id
  const version = db.prepare("PRAGMA user_version").get().user_version
  if (existing || objects.length || applicationId !== 0 || version !== 0) {
    checkIntegrity(db)
  }
  if (!objects.length) {
    if (applicationId !== 0 || version !== 0) {
      throw new IncompatibleCacheSchemaError(
        `Incompatible marker-only Records cache ${applicationId}/${version}`
      )
    }
    db.exec(SCHEMA_SQL)
  } else {
    if (applicationId !== APPLICATION_ID || version !== SCHEMA_VERSION) {
      throw new IncompatibleCacheSchemaError(
        `Incompatible Records cache schema ${applicationId}/${version}`
      )
    }
  }
  verifySchema(db)
}
