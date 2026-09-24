import { createCacheDb } from "./cache-db.js"

export const MAX_TILE_ZOOM = 14
export const MAX_TILE_BYTES = 2 * 1024 * 1024
export const MAX_TILE_CACHE_BYTES = 512 * 1024 * 1024

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tiles (
  z INTEGER NOT NULL,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  data BLOB NOT NULL,
  accessed_at INTEGER NOT NULL,
  PRIMARY KEY (z, x, y)
);
`

const cache = createCacheDb({
  fileName: "map-tiles.sqlite3",
  schema: SCHEMA,
  sanityQuery: "SELECT 1 FROM tiles LIMIT 1",
  logTag: "tile-cache",
  applicationId: 1380270932,
  schemaVersion: 2,
  prepareStatements: (db) => ({
    get: db.prepare("SELECT data FROM tiles WHERE z = ? AND x = ? AND y = ?"),
    touch: db.prepare(
      "UPDATE tiles SET accessed_at = ? WHERE z = ? AND x = ? AND y = ?"
    ),
    put: db.prepare(
      "INSERT OR REPLACE INTO tiles (z, x, y, data, accessed_at) VALUES (?, ?, ?, ?, ?)"
    ),
    dataSize: db.prepare(
      "SELECT COALESCE(SUM(length(data)), 0) AS bytes FROM tiles"
    ),
    removeOldest: db.prepare(
      "DELETE FROM tiles WHERE rowid = (SELECT rowid FROM tiles ORDER BY accessed_at, rowid LIMIT 1)"
    )
  })
})

export function validateTileCoordinates(z, x, y) {
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new Error("Invalid map tile coordinates")
  }
  const dimension = 2 ** z
  if (x < 0 || y < 0 || x >= dimension || y >= dimension) {
    throw new Error("Invalid map tile coordinates")
  }
}

/**
 * Open the tile cache database. Creates the file if it doesn't exist.
 * Auto-recovers from corruption by deleting and recreating the file.
 */
export function openTileCacheDb(dataDir) {
  return cache.open(dataDir)
}

/**
 * Close the tile cache database connection.
 */
export function closeTileCacheDb() {
  cache.close()
}

/**
 * Get a cached tile.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @returns {Buffer|null}
 */
export function getCachedTile(z, x, y) {
  validateTileCoordinates(z, x, y)
  if (!cache.getStmts()) return null
  const statements = cache.getStmts()
  const row = statements.get.get(z, x, y)
  if (row) statements.touch.run(Date.now(), z, x, y)
  return row ? row.data : null
}

/**
 * Store a tile in the cache.
 * @param {number} z
 * @param {number} x
 * @param {number} y
 * @param {Buffer} data
 */
export function putCachedTile(
  z,
  x,
  y,
  data,
  maxCacheBytes = MAX_TILE_CACHE_BYTES
) {
  validateTileCoordinates(z, x, y)
  if (
    !Buffer.isBuffer(data) ||
    data.length === 0 ||
    data.length > MAX_TILE_BYTES
  ) {
    throw new Error("Invalid map tile data")
  }
  if (!cache.getStmts()) return
  const statements = cache.getStmts()
  statements.put.run(z, x, y, data, Date.now())
  while (Number(statements.dataSize.get().bytes) > maxCacheBytes) {
    statements.removeOldest.run()
  }
}

/**
 * Get cache stats: tile count and total size in bytes.
 * @returns {{ tileCount: number, totalBytes: number }}
 */
export function getTileCacheStats() {
  if (!cache.getDb()) return { tileCount: 0, totalBytes: 0 }

  const db = cache.getDb()
  const countRow = db.prepare("SELECT COUNT(*) as tile_count FROM tiles").get()
  const pageCountRow = db.prepare("PRAGMA page_count").get()
  const pageSizeRow = db.prepare("PRAGMA page_size").get()

  const pageCount = Number(
    pageCountRow.page_count || Object.values(pageCountRow)[0] || 0
  )
  const pageSize = Number(
    pageSizeRow.page_size || Object.values(pageSizeRow)[0] || 0
  )

  return {
    tileCount: Number(countRow.tile_count || 0),
    totalBytes: pageCount * pageSize
  }
}

/**
 * Clear the entire tile cache.
 */
export function clearTileCache() {
  if (!cache.getDb()) return
  cache.getDb().exec("DELETE FROM tiles")
  cache.getDb().exec("VACUUM")
}
