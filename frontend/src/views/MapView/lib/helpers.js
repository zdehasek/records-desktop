import { isNsfw } from "../../../lib/formatters/visibility-utils.js"
import { layers, namedFlavor } from "@protomaps/basemaps"
import * as maplibregl from "maplibre-gl"

export function buildGeoJson(photos) {
  return {
    type: "FeatureCollection",
    features: photos.map((p) => ({
      type: "Feature",
      geometry: {
        type: "Point",
        coordinates: [p.longitude, p.latitude]
      },
      properties: {
        id: p.id,
        message_id: p.message_id,
        file_name: p.file_name,
        mime_type: p.mime_type,
        day_date: p.day_date,
        visibility: p.visibility || "visible"
      }
    }))
  }
}

export function addClusterLayers(map) {
  map.addLayer({
    id: "photo-clusters",
    type: "circle",
    source: "photos",
    filter: ["has", "point_count"],
    paint: {
      "circle-color": [
        "step",
        ["get", "point_count"],
        "#f0b429",
        10,
        "#f17e5a",
        50,
        "#e8528a"
      ],
      "circle-radius": ["step", ["get", "point_count"], 18, 10, 24, 50, 32],
      "circle-stroke-width": 2.5,
      "circle-stroke-color": "#1a1a2e"
    }
  })

  map.addLayer({
    id: "photo-cluster-count",
    type: "symbol",
    source: "photos",
    filter: ["has", "point_count"],
    layout: {
      "text-field": ["get", "point_count_abbreviated"],
      "text-size": 13,
      "text-font": ["Noto Sans Bold"]
    },
    paint: {
      "text-color": "#1a1a2e"
    }
  })

  // Small circle fallback for unclustered points — always present but hidden
  // behind DOM thumbnail markers. Visible when too many points exceed the
  // DOM marker cap or as a loading placeholder before thumbnails appear.
  map.addLayer({
    id: "photo-unclustered-fallback",
    type: "circle",
    source: "photos",
    filter: ["!", ["has", "point_count"]],
    paint: {
      "circle-radius": 5,
      "circle-color": "#e8528a",
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#1a1a2e"
    }
  })
}

export function buildMapStyle() {
  const flavor = namedFlavor("dark")
  return {
    version: 8,
    glyphs: `${new URL("glyphs/", document.baseURI).href}{fontstack}/{range}.pbf`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: ["rectiles://t/{z}/{x}/{y}"],
        maxzoom: 14,
        attribution: "&copy; OpenStreetMap"
      }
    },
    layers: layers("protomaps", flavor, { lang: "en" })
  }
}

export const MAX_DOM_MARKERS = 200

/**
 * Creates and manages DOM-based thumbnail markers for unclustered photo points.
 * Syncs markers on map move/data changes by querying the "photos" source for
 * unclustered features currently visible in the viewport.
 *
 * Deduplicates features that share the same pixel position (common when many
 * photos are taken at one GPS coordinate) and caps total DOM markers at
 * MAX_DOM_MARKERS for performance. A small circle fallback layer covers
 * any excess points.
 */
export function createMarkerManager(
  map,
  getMicroUrl,
  onMarkerClick,
  isBlurred,
  onMarkerContextMenu,
  onThumbnailError
) {
  // id → { marker, el, blurred }
  const active = new Map()

  function applyVisibility(entry, vis) {
    const blurred = isBlurred(vis)
    entry.visibility = vis
    entry.blurred = blurred
    const img = entry.el.querySelector("img")
    if (img) img.style.filter = blurred ? "blur(8px)" : ""
    let overlay = entry.el.querySelector(".map-marker__nsfw-overlay")
    if (isNsfw(vis) && !overlay) {
      overlay = document.createElement("div")
      overlay.className = "map-marker__nsfw-overlay"
      entry.el.appendChild(overlay)
    }
    if (overlay) {
      overlay.textContent = vis
      overlay.style.display = blurred ? "" : "none"
    }
    entry.el.style.cursor = blurred ? "default" : "pointer"
  }

  function markerEntries(features) {
    const byId = new Map()
    for (const feature of features) {
      const id = feature.properties.id
      if (!byId.has(id)) byId.set(id, feature)
    }

    const cellSize = 48
    const byCell = new Map()
    for (const [id, feature] of byId) {
      const point = map.project(feature.geometry.coordinates)
      const key = `${Math.round(point.x / cellSize)},${Math.round(point.y / cellSize)}`
      if (!byCell.has(key)) byCell.set(key, { id, feature })
    }
    return [...byCell.values()]
  }

  function capEntries(entries) {
    if (entries.length <= MAX_DOM_MARKERS) return entries
    const cx = map.getContainer().clientWidth / 2
    const cy = map.getContainer().clientHeight / 2
    entries.sort((a, b) => {
      const pa = map.project(a.feature.geometry.coordinates)
      const pb = map.project(b.feature.geometry.coordinates)
      const da = (pa.x - cx) ** 2 + (pa.y - cy) ** 2
      const db = (pb.x - cx) ** 2 + (pb.y - cy) ** 2
      return da - db
    })
    return entries.slice(0, MAX_DOM_MARKERS)
  }

  function update() {
    if (!map.isSourceLoaded("photos")) return

    const features = map.querySourceFeatures("photos", {
      filter: ["!", ["has", "point_count"]]
    })

    const entries = capEntries(markerEntries(features))

    const wanted = new Set(entries.map((e) => e.id))

    // Remove markers no longer wanted
    for (const [id, entry] of active) {
      if (!wanted.has(id)) {
        entry.marker.remove()
        active.delete(id)
      }
    }

    // Add or update markers
    for (const { id, feature } of entries) {
      const vis = feature.properties.visibility || "visible"
      const blurred = isBlurred(vis)

      if (active.has(id)) {
        applyVisibility(active.get(id), vis)
        continue
      }

      const coords = feature.geometry.coordinates
      const el = document.createElement("div")
      el.className = "map-marker"

      const img = document.createElement("img")
      img.src = getMicroUrl(id)
      img.alt = feature.properties.file_name || ""
      img.loading = "lazy"
      img.onerror = () => onThumbnailError(id, img)

      if (blurred) {
        img.style.filter = "blur(8px)"
      }

      el.appendChild(img)

      const entry = { marker: null, el, visibility: vis, blurred }

      // Click to open lightbox
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        if (!entry.blurred) onMarkerClick(id)
      })

      // Context menu for visibility/folders
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault()
        e.stopPropagation()
        onMarkerContextMenu(id, e.clientX, e.clientY)
      })

      // NSFW overlay
      if (isNsfw(vis)) {
        const overlay = document.createElement("div")
        overlay.className = "map-marker__nsfw-overlay"
        overlay.textContent = vis
        overlay.style.display = blurred ? "" : "none"
        el.appendChild(overlay)
      }

      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(coords)
        .addTo(map)

      entry.marker = marker
      active.set(id, entry)
    }
  }

  function destroy() {
    for (const entry of active.values()) {
      entry.marker.remove()
    }
    active.clear()
  }

  function refreshBlur() {
    for (const entry of active.values()) {
      applyVisibility(entry, entry.visibility)
    }
  }

  return { update, destroy, refreshBlur }
}
