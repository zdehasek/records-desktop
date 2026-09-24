import { PMTiles } from "pmtiles"

let active = null

export function acquireMapProtocol(maplibregl, api) {
  if (!active) {
    const archive = new PMTiles(
      new URL("basemap.pmtiles", document.baseURI).href
    )
    const fetchTile = async (z, x, y, waitForCache = false) => {
      try {
        const cached = await api.mapTiles.get(z, x, y)
        if (cached?.length) return new Uint8Array(cached).buffer
      } catch {
        // The online map still works when the optional cache is unavailable.
      }

      const result = await archive.getZxy(z, x, y)
      if (!result?.data) return new ArrayBuffer(0)
      const bytes = new Uint8Array(result.data)
      const cacheWrite = api.mapTiles
        .put(z, x, y, [...bytes])
        .catch((error) => console.warn("[map] Failed to cache tile", error))
      if (waitForCache) await cacheWrite
      return bytes.buffer
    }

    maplibregl.addProtocol("rectiles", async (params) => {
      const [z, x, y] = params.url
        .replace("rectiles://t/", "")
        .split("/")
        .map(Number)
      return { data: await fetchTile(z, x, y) }
    })
    active = { maplibregl, fetchTile, references: 0 }
  }

  active.references++
  let released = false
  return {
    fetchTile: active.fetchTile,
    release() {
      if (released || !active) return
      released = true
      active.references--
      if (active.references > 0) return
      active.maplibregl.removeProtocol("rectiles")
      active = null
    }
  }
}
