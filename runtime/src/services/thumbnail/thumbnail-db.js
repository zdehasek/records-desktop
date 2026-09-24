import { createCacheDb } from "../cache/cache-db.js"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS thumbnails (
  source_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  variant TEXT NOT NULL,
  data BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_id, source_revision, variant)
);
`

const cache = createCacheDb({
  fileName: "thumbnails.sqlite3",
  schema: SCHEMA,
  sanityQuery: "SELECT 1 FROM thumbnails LIMIT 1",
  logTag: "thumb-db",
  applicationId: 1380273485,
  schemaVersion: 2,
  prepareStatements: (db) => ({
    get: db.prepare(
      `SELECT data FROM thumbnails
       WHERE source_id = ? AND source_revision = ? AND variant = ?`
    ),
    put: db.prepare(
      `INSERT OR REPLACE INTO thumbnails
       (source_id, source_revision, variant, data, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ),
    prune: db.prepare(
      "DELETE FROM thumbnails WHERE source_id = ? AND source_revision <> ?"
    ),
    delete: db.prepare("DELETE FROM thumbnails WHERE source_id = ?"),
    clear: db.prepare("DELETE FROM thumbnails")
  })
})

/**
 * Open the thumbnail database. Creates the file if it doesn't exist.
 * Auto-recovers from corruption by deleting and recreating the file.
 */
export function openThumbnailDb(dataDir) {
  return cache.open(dataDir)
}

/**
 * Close the thumbnail database connection.
 */
export function closeThumbnailDb() {
  cache.close()
}

/**
 * Get a thumbnail blob from the database.
 * @param {string} sourceId
 * @param {string} sourceRevision
 * @param {string} variant - 'thumb', 'micro', or 'year'
 * @returns {Buffer|null}
 */
export function getThumbnail(sourceId, sourceRevision, variant) {
  const row = cache.getStmts().get.get(sourceId, sourceRevision, variant)
  return row ? Buffer.from(row.data) : null
}

/**
 * Store a thumbnail blob in the database (insert or replace).
 * @param {string} sourceId
 * @param {string} sourceRevision
 * @param {string} variant - 'thumb', 'micro', or 'year'
 * @param {Buffer} buffer - JPEG data
 */
export function putThumbnail(sourceId, sourceRevision, variant, buffer) {
  const now = new Date().toISOString()
  const statements = cache.getStmts()
  statements.put.run(
    sourceId,
    sourceRevision,
    variant,
    buffer,
    buffer.length,
    now
  )
  statements.prune.run(sourceId, sourceRevision)
}

/**
 * Delete all thumbnail variants and revisions for a source.
 * @param {string} sourceId
 */
export function deleteThumbnails(sourceId) {
  cache.getStmts().delete.run(sourceId)
}

export function clearThumbnails() {
  cache.getStmts().clear.run()
}
