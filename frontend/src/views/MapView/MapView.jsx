import "maplibre-gl/dist/maplibre-gl.css"
import { Lightbox } from "../../components/common/Lightbox.jsx"
import {
  ContextMenuOverlay,
  FolderPickerOverlay
} from "../../components/common/OverlayMenus.jsx"
import { useApp } from "../../context/AppContext.jsx"
import { useConfirm } from "../../context/ConfirmContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { useContextMenu } from "../../hooks/useContextMenu.js"
import { useFolderPicker } from "../../hooks/useFolderPicker.js"
import {
  createLightboxNav,
  goToTimeline
} from "../../lib/composables/lightbox-helpers.js"
import { formatDate } from "../../lib/formatters/date-utils.js"
import { isNsfw } from "../../lib/formatters/visibility-utils.js"
import { acquireMapProtocol } from "../../lib/map-protocol.js"
import { buildVisibilityMenuItems } from "../../lib/visibility-menu.js"
import {
  addClusterLayers,
  buildGeoJson,
  buildMapStyle,
  createMarkerManager
} from "./lib/helpers.js"
import * as maplibregl from "maplibre-gl"
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show
} from "solid-js"

function cachedTileCoordinates(photos, maxZoom = 12) {
  if (!photos.length) return []
  const x = (lng, zoom) => Math.floor(((lng + 180) / 360) * 2 ** zoom)
  const y = (lat, zoom) => {
    const radians = (lat * Math.PI) / 180
    return Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
        2) *
        2 ** zoom
    )
  }
  const unique = new Map()
  for (const photo of photos) {
    for (let zoom = 0; zoom <= maxZoom; zoom++) {
      const centerX = x(photo.longitude, zoom)
      const centerY = y(Math.max(-85, Math.min(85, photo.latitude)), zoom)
      const radius = zoom >= 10 ? 1 : 0
      for (let offsetX = -radius; offsetX <= radius; offsetX++) {
        for (let offsetY = -radius; offsetY <= radius; offsetY++) {
          const tileCount = 2 ** zoom
          const tile = {
            z: zoom,
            x: (centerX + offsetX + tileCount) % tileCount,
            y: Math.max(0, Math.min(tileCount - 1, centerY + offsetY))
          }
          unique.set(`${tile.z}/${tile.x}/${tile.y}`, tile)
          if (unique.size >= 10_000) return [...unique.values()]
        }
      }
    }
  }
  return [...unique.values()]
}

function MapView(props) {
  const confirmDialog = useConfirm()
  const {
    state,
    geoPhotos,
    allPhotos,
    noGpsPhotos,
    loadGeoPhotos,
    loadAllPhotos,
    loadNoGpsPhotos,
    writeGpsToFile,
    getAttachmentUrl,
    getThumbnailUrl,
    getMicroThumbnailUrl,
    blurNsfw,
    setMessageVisibility,
    deleteMessage,
    folders,
    dotFilesVisible,
    selectDay,
    setView,
    handleThumbnailError
  } = useApp()
  const api = useApi()

  let mapContainer
  let map = null
  let markerMgr = null
  const lightbox = createLightboxNav(allPhotos)
  const [mapReady, setMapReady] = createSignal(false)
  const contextMenu = useContextMenu()
  const folderPicker = useFolderPicker()

  // Tile cache state
  const [cacheStats, setCacheStats] = createSignal(null)
  const [cacheStatsLoaded, setCacheStatsLoaded] = createSignal(false)
  const [cacheDownloading, setCacheDownloading] = createSignal(false)
  const [cacheProgress, setCacheProgress] = createSignal(null)
  const cachedTileCount = () => cacheStats()?.tileCount || 0
  const mapOfflineAvailable = () => Boolean(api.capabilities?.mapOffline)
  let fetchMapTile = null
  let mapProtocol = null

  // Address search state
  const [searchQuery, setSearchQuery] = createSignal("")
  const [searchResults, setSearchResults] = createSignal([])
  const [searchOpen, setSearchOpen] = createSignal(false)
  let searchDebounce = null

  const clearSearch = () => {
    setSearchQuery("")
    setSearchResults([])
    setSearchOpen(false)
    if (searchDebounce) {
      clearTimeout(searchDebounce)
      searchDebounce = null
    }
  }

  const searchAddress = (query) => {
    if (searchDebounce) clearTimeout(searchDebounce)
    if (!query.trim()) {
      setSearchResults([])
      return
    }
    searchDebounce = setTimeout(async () => {
      try {
        const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=5`
        const res = await fetch(url)
        if (!res.ok) return
        const data = await res.json()
        setSearchResults(data.features || [])
      } catch {
        // ignore network errors — results stay empty
      }
    }, 300)
  }

  const flyToResult = (feature) => {
    const [lon, lat] = feature.geometry.coordinates
    if (map) {
      map.flyTo({ center: [lon, lat], zoom: 14 })
    }
    clearSearch()
  }

  const formatResult = (feature) => {
    const props = feature?.properties || {}
    const parts = [
      props.name,
      props.street,
      props.city,
      props.state,
      props.country
    ].filter(Boolean)
    return parts.join(", ") || "Unknown location"
  }

  const formatBytes = (bytes) => {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  // No-GPS drawer state
  const [drawerOpen, setDrawerOpen] = createSignal(false)
  const [placingPhoto, setPlacingPhoto] = createSignal(null)
  const [placingPhotos, setPlacingPhotos] = createSignal([])
  const [previewLngLat, setPreviewLngLat] = createSignal(null)
  const [saving, setSaving] = createSignal(false)
  let previewMarker = null

  // Drawer multi-select state (shift-click range selection)
  const [drawerSelected, setDrawerSelected] = createSignal(new Set())
  let lastClickedIdx = -1

  const toggleDrawerSelect = (photoId, idx, shiftKey) => {
    if (shiftKey && lastClickedIdx >= 0) {
      // Shift-click: select range from last click to current
      const photos = noGpsPhotos()
      const lo = Math.min(lastClickedIdx, idx)
      const hi = Math.max(lastClickedIdx, idx)
      setDrawerSelected((prev) => {
        const next = new Set(prev)
        for (let i = lo; i <= hi; i++) {
          next.add(photos[i].id)
        }
        return next
      })
    } else {
      // Normal click: toggle single photo
      setDrawerSelected((prev) => {
        const next = new Set(prev)
        if (next.has(photoId)) next.delete(photoId)
        else next.add(photoId)
        return next
      })
    }
    lastClickedIdx = idx
  }

  const clearDrawerSelection = () => {
    setDrawerSelected(new Set())
    lastClickedIdx = -1
  }

  const isDrawerSelected = (id) => drawerSelected().has(id)
  const drawerSelectionCount = () => drawerSelected().size

  // No-GPS lightbox state (separate from the geo-tagged photo lightbox)
  const noGpsLightbox = createLightboxNav(noGpsPhotos)

  const openLightboxForPhoto = (photoId) => {
    noGpsLightbox.close() // close no-GPS lightbox if open
    const idx = allPhotos().findIndex((p) => p.id === photoId)
    if (idx >= 0) lightbox.open(idx)
  }

  const openNoGpsLightbox = (photoId) => {
    lightbox.close() // close geo-tagged lightbox if open
    const idx = noGpsPhotos().findIndex((p) => p.id === photoId)
    if (idx >= 0) noGpsLightbox.open(idx)
  }

  const handleSetLocation = () => {
    const photo = noGpsLightbox.current()
    if (!photo) return
    noGpsLightbox.close()
    // If the current photo is part of a selection, place all selected photos
    if (drawerSelected().has(photo.id) && drawerSelectionCount() > 1) {
      startBatchPlacement()
    } else {
      startPlacement(photo)
    }
  }

  const startBatchPlacement = () => {
    const selected = drawerSelected()
    const photos = noGpsPhotos().filter((p) => selected.has(p.id))
    if (photos.length === 0) return
    clearDrawerSelection()
    setPlacingPhotos(photos)
    startPlacement(photos[0])
  }

  const handleMarkerContextMenu = (attachmentId, x, y) => {
    const photo = geoPhotos().find((p) => p.id === attachmentId)
    if (!photo) return
    const vis = photo.visibility || "visible"

    contextMenu.open(
      x,
      y,
      buildVisibilityMenuItems({
        visibility: vis,
        onVisible: () => setMessageVisibility(photo.message_id, "visible"),
        onMoveToFolder: () => folderPicker.open(x, y, photo.message_id, vis)
      })
    )
  }

  // Auto-close or adjust no-GPS lightbox when the photo list shrinks
  // (e.g. after setting location via info panel, or deleting a photo)
  // Also prune drawer selection to only include photos still in the list
  createEffect(
    on(
      () => noGpsPhotos().length,
      (len) => {
        const idx = noGpsLightbox.index()
        if (idx >= 0) {
          if (len === 0) {
            noGpsLightbox.close()
          } else if (idx >= len) {
            noGpsLightbox.open(len - 1)
          }
        }
        // Prune selection to only keep IDs still in the list
        const currentIds = new Set(noGpsPhotos().map((p) => p.id))
        setDrawerSelected((prev) => {
          const next = new Set([...prev].filter((id) => currentIds.has(id)))
          return next.size === prev.size ? prev : next
        })
      },
      { defer: true }
    )
  )

  // --- Placement mode ---

  const startPlacement = (photo) => {
    setPlacingPhoto(photo)
    setPreviewLngLat(null)
    if (previewMarker) {
      previewMarker.remove()
      previewMarker = null
    }
    if (map) map.getCanvas().style.cursor = "crosshair"
  }

  const cancelPlacement = () => {
    setPlacingPhoto(null)
    setPlacingPhotos([])
    setPreviewLngLat(null)
    if (previewMarker) {
      previewMarker.remove()
      previewMarker = null
    }
    if (map) map.getCanvas().style.cursor = ""
  }

  const confirmPlacement = async () => {
    const photo = placingPhoto()
    const lngLat = previewLngLat()
    if (!photo || !lngLat) return

    const batch = placingPhotos()

    setSaving(true)
    try {
      if (batch.length > 1) {
        // Batch mode: save all photos at this location
        for (let i = 0; i < batch.length; i++) {
          await writeGpsToFile(batch[i].id, lngLat[1], lngLat[0])
        }
      } else {
        // Single photo mode
        await writeGpsToFile(photo.id, lngLat[1], lngLat[0])
      }
      cancelPlacement()
    } catch (err) {
      console.error("[map] Failed to save GPS:", err)
    } finally {
      setSaving(false)
    }
  }

  function setupSource(photos) {
    map.addSource("photos", {
      type: "geojson",
      data: buildGeoJson(photos),
      cluster: true,
      clusterMaxZoom: 16,
      clusterRadius: 60
    })
  }

  function setupLayers() {
    addClusterLayers(map)

    // Create marker manager for unclustered thumbnail markers
    markerMgr = createMarkerManager(
      map,
      getMicroThumbnailUrl,
      openLightboxForPhoto,
      (vis) => isNsfw(vis) && blurNsfw(),
      handleMarkerContextMenu,
      handleThumbnailError
    )

    // Sync DOM markers after data/view changes (throttled)
    let markerRaf = null
    const scheduleMarkerUpdate = () => {
      if (markerRaf) return
      markerRaf = requestAnimationFrame(() => {
        markerRaf = null
        markerMgr.update()
      })
    }
    map.on("moveend", scheduleMarkerUpdate)
    map.on("sourcedata", scheduleMarkerUpdate)
    // Initial sync after layers are added
    scheduleMarkerUpdate()
  }

  const startCacheDownload = async () => {
    if (cacheDownloading()) return
    setCacheDownloading(true)
    setCacheProgress(null)
    try {
      const coordinates = cachedTileCoordinates(geoPhotos())
      let done = 0
      for (const coordinate of coordinates) {
        try {
          await fetchMapTile?.(coordinate.z, coordinate.x, coordinate.y, true)
        } catch (error) {
          console.warn("[map] Failed to cache tile", coordinate, error)
        }
        done++
        setCacheProgress({ done, total: coordinates.length })
      }
    } catch (err) {
      console.error("[map] Cache warmup failed:", err)
    } finally {
      setCacheDownloading(false)
      setCacheProgress(null)
      // Refresh stats after download
      if (api.mapTiles.stats) {
        api.mapTiles
          .stats()
          .then((stats) => {
            setCacheStats(stats)
            setCacheStatsLoaded(true)
          })
          .catch(() => {})
      }
    }
  }

  const loadCacheStats = async () => {
    if (!api.mapTiles.stats || cacheStatsLoaded()) return
    try {
      const stats = await api.mapTiles.stats()
      setCacheStats(stats)
      setCacheStatsLoaded(true)
    } catch {
      // ignore — cache stats are optional UI detail
    }
  }

  onMount(async () => {
    await Promise.all([loadGeoPhotos(), loadAllPhotos(), loadNoGpsPhotos()])

    // Defer cache stats until map becomes visible to avoid blocking startup
    if (!props.hidden) {
      loadCacheStats()
    }

    // Auto-open drawer if there are no-GPS photos
    if (noGpsPhotos().length > 0) {
      setDrawerOpen(true)
    }

    // Keyboard shortcuts: G toggles drawer, Escape cancels placement or search
    const handleMapKeyDown = (e) => {
      // Skip when map is hidden (pre-rendered in background)
      if (props.hidden) return
      if (
        e.key.toLowerCase() === "g" &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        const tag = document.activeElement?.tagName
        if (tag === "INPUT" || tag === "TEXTAREA") return
        if (document.activeElement?.contentEditable === "true") return
        e.preventDefault()
        setDrawerOpen((v) => !v)
      }
      if (e.key === "Escape" && placingPhoto()) {
        e.preventDefault()
        cancelPlacement()
      }
    }
    window.addEventListener("keydown", handleMapKeyDown)
    onCleanup(() => window.removeEventListener("keydown", handleMapKeyDown))

    // Close search dropdown on outside click
    const handleOutsideClick = (e) => {
      if (!e.target.closest(".map-search")) {
        setSearchOpen(false)
      }
    }
    document.addEventListener("mousedown", handleOutsideClick)
    onCleanup(() =>
      document.removeEventListener("mousedown", handleOutsideClick)
    )

    mapProtocol = acquireMapProtocol(maplibregl, api)
    fetchMapTile = mapProtocol.fetchTile

    const photos = geoPhotos()
    const mapStyle = buildMapStyle()

    let center = [0, 20]
    let zoom = 2

    if (photos.length > 0) {
      const bounds = new maplibregl.LngLatBounds()
      for (const p of photos) {
        bounds.extend([p.longitude, p.latitude])
      }
      center = bounds.getCenter().toArray()
      zoom = 12
    }

    map = new maplibregl.Map({
      container: mapContainer,
      style: mapStyle,
      center,
      zoom
    })

    map.addControl(new maplibregl.NavigationControl(), "top-right")

    map.on("load", () => {
      setupSource(photos)
      setupLayers()

      if (photos.length > 0) {
        const bounds = new maplibregl.LngLatBounds()
        for (const p of photos) {
          bounds.extend([p.longitude, p.latitude])
        }
        map.fitBounds(bounds, { padding: 60, maxZoom: 15 })
      }

      setMapReady(true)
    })

    // Click cluster → zoom in
    map.on("click", "photo-clusters", async (e) => {
      const features = map.queryRenderedFeatures(e.point, {
        layers: ["photo-clusters"]
      })
      if (!features.length) return
      const clusterId = features[0].properties.cluster_id
      const source = map.getSource("photos")
      const zoom = await source.getClusterExpansionZoom(clusterId)
      map.easeTo({
        center: features[0].geometry.coordinates,
        zoom
      })
    })

    // Click unclustered fallback circle → open lightbox
    map.on("click", "photo-unclustered-fallback", (e) => {
      if (!e.features?.length) return
      openLightboxForPhoto(e.features[0].properties.id)
    })

    // Cursor feedback
    map.on("mouseenter", "photo-clusters", () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", "photo-clusters", () => {
      map.getCanvas().style.cursor = ""
    })
    map.on("mouseenter", "photo-unclustered-fallback", () => {
      map.getCanvas().style.cursor = "pointer"
    })
    map.on("mouseleave", "photo-unclustered-fallback", () => {
      map.getCanvas().style.cursor = ""
    })

    // General map click for placement mode
    map.on("click", (e) => {
      if (!placingPhoto()) return

      // Ignore clicks on clusters or unclustered points
      const clusterFeatures = map.queryRenderedFeatures(e.point, {
        layers: ["photo-clusters", "photo-unclustered-fallback"]
      })
      if (clusterFeatures.length > 0) return

      const lngLat = [e.lngLat.lng, e.lngLat.lat]
      setPreviewLngLat(lngLat)

      // Update or create preview marker
      if (previewMarker) {
        previewMarker.setLngLat(lngLat)
      } else {
        const el = document.createElement("div")
        el.className = "map-marker map-marker--preview"

        const img = document.createElement("img")
        img.src = getThumbnailUrl(placingPhoto().id)
        img.alt = placingPhoto().file_name || ""
        img.draggable = false
        img.onerror = () => handleThumbnailError(placingPhoto().id, img)
        el.appendChild(img)

        previewMarker = new maplibregl.Marker({
          element: el,
          anchor: "center",
          draggable: true
        })
          .setLngLat(lngLat)
          .addTo(map)

        previewMarker.on("dragend", () => {
          const pos = previewMarker.getLngLat()
          setPreviewLngLat([pos.lng, pos.lat])
        })
      }
    })
  })

  onCleanup(() => {
    if (previewMarker) {
      previewMarker.remove()
      previewMarker = null
    }
    if (markerMgr) {
      markerMgr.destroy()
      markerMgr = null
    }
    if (map) {
      map.remove()
      map = null
    }
    mapProtocol?.release()
    mapProtocol = null
  })

  // Update GeoJSON source when geoPhotos changes
  createEffect(
    on(
      () => geoPhotos(),
      (photos) => {
        if (!map || !mapReady()) return
        const source = map.getSource("photos")
        if (source) {
          source.setData(buildGeoJson(photos))
          // Force marker sync after source processes the new data.
          // sourcedata event may fire before isSourceLoaded is true,
          // causing update() to bail out. Listen for idle to be safe.
          map.once("idle", () => {
            if (markerMgr) markerMgr.update()
          })
        }
      },
      { defer: true }
    )
  )

  // Refresh marker blur state when NSFW mode toggles
  createEffect(
    on(
      () => blurNsfw(),
      () => {
        if (markerMgr) markerMgr.refreshBlur()
      },
      { defer: true }
    )
  )

  // Resize map when drawer opens/closes
  createEffect(
    on(
      () => drawerOpen(),
      () => {
        if (map) {
          setTimeout(() => map.resize(), 250)
        }
      },
      { defer: true }
    )
  )

  // When map becomes visible: resize (MapLibre needs this after being hidden)
  // and re-fetch photo data so the view is always fresh.
  createEffect(
    on(
      () => props.hidden,
      (hidden) => {
        if (!hidden && map) {
          // Allow one frame for the layout to settle after visibility change,
          // then resize so MapLibre adapts to the actual container dimensions.
          requestAnimationFrame(() => {
            map.resize()
            // Safety resize after layout fully settles (absolute → flex)
            setTimeout(() => map.resize(), 100)
          })
          // Re-fetch photo data so the map always shows current state
          loadGeoPhotos()
          loadAllPhotos()
          loadNoGpsPhotos()
          loadCacheStats()
        }
      },
      { defer: true }
    )
  )

  const MapLightboxes = () => (
    <>
      <Show when={lightbox.index() >= 0 && lightbox.current()}>
        <Lightbox
          photoId={lightbox.current().id}
          url={getAttachmentUrl(lightbox.current().id)}
          alt={lightbox.current().file_name || "Photo"}
          mimeType={lightbox.current().mime_type}
          date={
            lightbox.current().day_date
              ? formatDate(lightbox.current().day_date)
              : ""
          }
          counter={`${lightbox.index() + 1} / ${allPhotos().length}`}
          hasPrev={lightbox.index() > 0}
          hasNext={lightbox.index() < allPhotos().length - 1}
          onClose={lightbox.close}
          onPrev={lightbox.prev}
          onNext={lightbox.next}
          visibility={lightbox.current().visibility}
          blurNsfw={blurNsfw()}
          folders={folders()}
          dotFilesVisible={dotFilesVisible()}
          onVisibilityChange={(vis) =>
            setMessageVisibility(lightbox.current().message_id, vis)
          }
          onAttachmentUpdated={() => {
            loadGeoPhotos()
            loadAllPhotos()
          }}
          onDelete={async () => {
            const photo = lightbox.current()
            if (!photo) return
            if (!(await confirmDialog("Move this photo to Trash?"))) return
            await deleteMessage(photo.message_id)
            lightbox.close()
          }}
          onGoToTimeline={() => {
            const photo = lightbox.current()
            if (!photo) return
            lightbox.close()
            goToTimeline({
              dayDate: photo.day_date,
              state,
              api,
              selectDay,
              setView
            })
          }}
        />
      </Show>

      <Show when={noGpsLightbox.index() >= 0 && noGpsLightbox.current()}>
        <Lightbox
          photoId={noGpsLightbox.current().id}
          url={getAttachmentUrl(noGpsLightbox.current().id)}
          alt={noGpsLightbox.current().file_name || "Photo"}
          mimeType={noGpsLightbox.current().mime_type}
          date={
            noGpsLightbox.current().day_date
              ? formatDate(noGpsLightbox.current().day_date)
              : ""
          }
          counter={`${noGpsLightbox.index() + 1} / ${noGpsPhotos().length}`}
          hasPrev={noGpsLightbox.index() > 0}
          hasNext={noGpsLightbox.index() < noGpsPhotos().length - 1}
          onClose={noGpsLightbox.close}
          onPrev={noGpsLightbox.prev}
          onNext={noGpsLightbox.next}
          visibility={noGpsLightbox.current().visibility}
          blurNsfw={blurNsfw()}
          folders={folders()}
          dotFilesVisible={dotFilesVisible()}
          onVisibilityChange={(vis) =>
            setMessageVisibility(noGpsLightbox.current().message_id, vis)
          }
          onAttachmentUpdated={() => {
            loadNoGpsPhotos()
            loadGeoPhotos()
          }}
          onSetLocation={handleSetLocation}
          onDelete={async () => {
            const photo = noGpsLightbox.current()
            if (!photo) return
            if (!(await confirmDialog("Move this photo to Trash?"))) return
            await deleteMessage(photo.message_id)
            noGpsLightbox.close()
          }}
          onGoToTimeline={() => {
            const photo = noGpsLightbox.current()
            if (!photo) return
            noGpsLightbox.close()
            goToTimeline({
              dayDate: photo.day_date,
              state,
              api,
              selectDay,
              setView
            })
          }}
        />
      </Show>
    </>
  )

  return (
    <div class="map-view" classList={{ "map-view--hidden": props.hidden }}>
      <div class="map-view__container" ref={mapContainer} />

      {/* Address search bar */}
      <div class="map-search">
        <div class="map-search__input-wrap">
          <input
            class="map-search__input"
            type="text"
            placeholder="Search address…"
            value={searchQuery()}
            onInput={(e) => {
              setSearchQuery(e.target.value)
              searchAddress(e.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => {
              if (searchResults().length > 0) setSearchOpen(true)
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                clearSearch()
                e.target.blur()
              }
            }}
          />
          <Show when={searchQuery()}>
            <button
              class="map-search__clear"
              onClick={clearSearch}
              title="Clear search"
            >
              &times;
            </button>
          </Show>
        </div>
        <Show when={searchOpen() && searchResults().length > 0}>
          <ul class="map-search__results">
            <For each={searchResults()}>
              {(feature) => (
                <li
                  class="map-search__result"
                  onClick={() => flyToResult(feature)}
                >
                  {formatResult(feature)}
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      {/* Tile cache download control */}
      <Show when={geoPhotos().length > 0 && mapOfflineAvailable()}>
        <div class="map-cache-control">
          <Show
            when={cacheDownloading()}
            fallback={
              <button
                class="map-cache-control__btn"
                onClick={startCacheDownload}
                title={
                  cachedTileCount() > 0
                    ? `${cacheStats().tileCount} tiles cached (${formatBytes(cacheStats().totalBytes)}). Click to refresh.`
                    : "Download map tiles for offline use"
                }
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d={
                      cachedTileCount() > 0
                        ? "M5 13l4 4L19 7"
                        : "M12 5v14M5 12l7 7 7-7"
                    }
                  />
                </svg>
                <span>
                  {cachedTileCount() > 0 ? "Tiles cached" : "Download"}
                </span>
              </button>
            }
          >
            <div class="map-cache-control__progress">
              <div
                class="map-cache-control__bar"
                style={{
                  width: cacheProgress()
                    ? `${Math.round((cacheProgress().done / cacheProgress().total) * 100)}%`
                    : "0%"
                }}
              />
              <span class="map-cache-control__label">
                {cacheProgress()
                  ? `${cacheProgress().done} / ${cacheProgress().total}`
                  : "Starting\u2026"}
              </span>
            </div>
          </Show>
        </div>
      </Show>

      <Show
        when={
          mapReady() && geoPhotos().length === 0 && noGpsPhotos().length === 0
        }
      >
        <div class="map-view__empty-overlay">
          <div class="map-view__empty-message">
            <h3 class="empty-state__title">No locations yet</h3>
            <p class="empty-state__subtitle">
              Photos with GPS data will appear on the map
            </p>
          </div>
        </div>
      </Show>

      {/* Placement mode action bar */}
      <Show when={placingPhoto()}>
        <div class="map-view__placement-bar">
          <span class="map-view__placement-label">
            <Show
              when={placingPhotos().length > 1}
              fallback={
                <>
                  Click the map to place &ldquo;{placingPhoto().file_name}
                  &rdquo;
                </>
              }
            >
              Click the map to place {placingPhotos().length} photos
            </Show>
          </span>
          <Show when={previewLngLat()}>
            <span class="map-view__placement-coords">
              {previewLngLat()[1].toFixed(4)}, {previewLngLat()[0].toFixed(4)}
            </span>
          </Show>
          <div class="map-view__placement-actions">
            <button
              class="btn btn--ghost btn--sm"
              onClick={cancelPlacement}
              disabled={saving()}
            >
              Cancel
            </button>
            <button
              class="btn btn--primary btn--sm"
              onClick={confirmPlacement}
              disabled={!previewLngLat() || saving()}
            >
              {saving()
                ? "Saving\u2026"
                : placingPhotos().length > 1
                  ? `Save location (${placingPhotos().length})`
                  : "Save location"}
            </button>
          </div>
        </div>
      </Show>

      {/* No-GPS photos drawer */}
      <Show when={noGpsPhotos().length > 0}>
        <div
          class="no-gps-drawer"
          classList={{ "no-gps-drawer--open": drawerOpen() }}
        >
          <button
            class="no-gps-drawer__toggle"
            onClick={() => setDrawerOpen((v) => !v)}
            title="Toggle no-GPS photos (G)"
          >
            <span class="no-gps-drawer__badge">{noGpsPhotos().length}</span>
            <span class="no-gps-drawer__toggle-label">
              Media without location
            </span>
            <svg
              class="no-gps-drawer__chevron"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                d={drawerOpen() ? "M19 9l-7 7-7-7" : "M5 15l7-7 7 7"}
              />
            </svg>
          </button>

          <Show when={drawerOpen()}>
            <Show when={drawerSelectionCount() > 0}>
              <div class="no-gps-drawer__selection-bar">
                <span class="no-gps-drawer__selection-count">
                  {drawerSelectionCount()} selected
                </span>
                <button
                  class="btn btn--primary btn--sm"
                  onClick={startBatchPlacement}
                >
                  Set location
                </button>
                <button
                  class="btn btn--ghost btn--sm"
                  onClick={clearDrawerSelection}
                >
                  Clear
                </button>
              </div>
            </Show>
            <Show when={!props.hidden}>
              <div class="no-gps-drawer__strip">
                <For each={noGpsPhotos()}>
                  {(photo, idx) => (
                    <button
                      class="no-gps-drawer__thumb"
                      classList={{
                        "no-gps-drawer__thumb--active":
                          placingPhoto()?.id === photo.id,
                        "no-gps-drawer__thumb--selected": isDrawerSelected(
                          photo.id
                        )
                      }}
                      onClick={(e) => {
                        if (e.shiftKey) {
                          toggleDrawerSelect(photo.id, idx(), e.shiftKey)
                        } else if (drawerSelectionCount() > 0) {
                          toggleDrawerSelect(photo.id, idx(), false)
                        } else {
                          openNoGpsLightbox(photo.id)
                        }
                      }}
                      title={`${photo.file_name}\n${photo.day_date || ""}${drawerSelectionCount() > 0 ? "\nClick to toggle selection" : "\nShift+click to select"}`}
                    >
                      <img
                        src={getThumbnailUrl(photo.id)}
                        alt={photo.file_name || "Photo"}
                        loading="lazy"
                        draggable={false}
                        onError={(e) =>
                          handleThumbnailError(photo.id, e.currentTarget)
                        }
                      />
                      <Show when={photo.mime_type?.startsWith("video/")}>
                        <div class="no-gps-drawer__play-icon">
                          <svg viewBox="0 0 24 24">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        </div>
                      </Show>
                      <Show when={isDrawerSelected(photo.id)}>
                        <span class="no-gps-drawer__check">
                          <svg viewBox="0 0 24 24">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      </Show>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      <ContextMenuOverlay state={contextMenu} />
      <FolderPickerOverlay
        state={folderPicker}
        folders={folders()}
        dotFilesVisible={dotFilesVisible()}
        onSelect={(folder) =>
          setMessageVisibility(folderPicker.messageId(), folder)
        }
      />

      <MapLightboxes />
    </div>
  )
}

export default MapView
