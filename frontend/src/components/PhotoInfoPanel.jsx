import { useApi } from "../context/PlatformContext.jsx"
import { formatDate } from "../lib/formatters/date-utils.js"
import { acquireMapProtocol } from "../lib/map-protocol.js"
import { CompactDatePicker } from "./common/CompactDatePicker.jsx"
import { CompactTimePicker } from "./common/CompactTimePicker.jsx"
import { createEffect, createSignal, on, onCleanup, Show } from "solid-js"

// maplibre-gl and @protomaps/basemaps are loaded dynamically in initMap()
// to avoid pulling ~870KB into the main bundle (they're already lazy-loaded
// via MapView). We cache the imports so subsequent calls don't re-import.
let _maplibregl = null
let _layers = null
let _namedFlavor = null

function toDatetimeLocalValue(value) {
  if (!value) return ""

  const exifMatch = value.match(
    /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/
  )
  if (exifMatch) {
    const [, year, month, day, hour, minute, second = "00"] = exifMatch
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""

  const year = String(date.getFullYear())
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  const second = String(date.getSeconds()).padStart(2, "0")

  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function toStoredCreatedAt(value) {
  if (!value) return null

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  )
  if (!match) return null

  const [, year, month, day, hour, minute, second = "00"] = match
  const parts = [year, month, day, hour, minute, second].map(Number)
  const [
    yearNumber,
    monthNumber,
    dayNumber,
    hourNumber,
    minuteNumber,
    secondNumber
  ] = parts
  const date = new Date(0)
  date.setUTCFullYear(yearNumber, monthNumber - 1, dayNumber)
  date.setUTCHours(hourNumber, minuteNumber, secondNumber, 0)
  if (
    date.getUTCFullYear() !== yearNumber ||
    date.getUTCMonth() !== monthNumber - 1 ||
    date.getUTCDate() !== dayNumber ||
    date.getUTCHours() !== hourNumber ||
    date.getUTCMinutes() !== minuteNumber ||
    date.getUTCSeconds() !== secondNumber
  ) {
    return null
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000`
}

function coordinatesPatch(latitude, longitude) {
  const latitudeText = latitude.trim()
  const longitudeText = longitude.trim()
  if (Boolean(latitudeText) !== Boolean(longitudeText)) {
    throw new Error("Enter both latitude and longitude, or leave both blank.")
  }

  const parsedLatitude = latitudeText ? Number(latitudeText) : null
  const parsedLongitude = longitudeText ? Number(longitudeText) : null
  if (
    (latitudeText && !Number.isFinite(parsedLatitude)) ||
    (longitudeText && !Number.isFinite(parsedLongitude)) ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    parsedLongitude < -180 ||
    parsedLongitude > 180
  ) {
    throw new Error(
      "Latitude must be between -90 and 90, and longitude between -180 and 180."
    )
  }

  return { latitude: parsedLatitude, longitude: parsedLongitude }
}

function mediaInfoPatch({
  image,
  latitude,
  longitude,
  dateTaken,
  make,
  model
}) {
  const dateTakenText = dateTaken.trim()
  const storedCreatedAt = toStoredCreatedAt(dateTakenText)
  if (dateTakenText && !storedCreatedAt) {
    throw new Error("Enter a valid date and time.")
  }
  return {
    ...(image && {
      Make: make.trim() || null,
      Model: model.trim() || null,
      ...coordinatesPatch(latitude, longitude)
    }),
    ...(storedCreatedAt && { createdAt: storedCreatedAt })
  }
}

function datePart(value) {
  return value ? value.slice(0, 10) : ""
}

function timePart(value) {
  if (!value) return ""
  const time = value.slice(11)
  if (time.length === 5) return `${time}:00`
  return time
}

function combineDateTimeParts(date, time) {
  if (!date) return ""
  const normalizedTime = time ? timePart(`1970-01-01T${time}`) : "00:00:00"
  return `${date}T${normalizedTime}`
}

async function loadMapLibs() {
  if (!_maplibregl) {
    const [ml, basemaps] = await Promise.all([
      import("maplibre-gl"),
      import("@protomaps/basemaps")
    ])
    _maplibregl = ml
    _layers = basemaps.layers
    _namedFlavor = basemaps.namedFlavor
  }
  return {
    maplibregl: _maplibregl,
    layers: _layers,
    namedFlavor: _namedFlavor
  }
}

export function PhotoInfoPanel(props) {
  const api = useApi()
  let mapContainer
  let mapInstance = null
  let mapProtocol = null
  const isImage = () => props.attachment?.mime_type?.startsWith("image/")

  // Editable field signals
  const [latitude, setLatitude] = createSignal("")
  const [longitude, setLongitude] = createSignal("")
  const [dateTaken, setDateTaken] = createSignal("")
  const [make, setMake] = createSignal("")
  const [model, setModel] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [dirty, setDirty] = createSignal(false)
  const [saveError, setSaveError] = createSignal("")
  let loadedAttachmentId = null

  // Background refreshes must not overwrite edits for the same attachment.
  createEffect(
    on(
      () => props.attachment,
      (att) => {
        if (!att) return
        if (dirty() && loadedAttachmentId === att.id) return
        loadedAttachmentId = att.id
        setLatitude(att.latitude != null ? String(att.latitude) : "")
        setLongitude(att.longitude != null ? String(att.longitude) : "")
        setDateTaken(
          toDatetimeLocalValue(
            att.created_at || att.exif_data?.DateTimeOriginal || ""
          )
        )
        setMake(att.exif_data?.Make || "")
        setModel(att.exif_data?.Model || "")
        setDirty(false)
        setSaveError("")
      }
    )
  )

  const setField = (setter) => (e) => {
    setter(e.target.value)
    setDirty(true)
    setSaveError("")
  }

  const setDatePart = (date) => {
    setDateTaken(combineDateTimeParts(date, timePart(dateTaken())))
    setDirty(true)
    setSaveError("")
  }

  const setTimePart = (time) => {
    setDateTaken(combineDateTimeParts(datePart(dateTaken()), time))
    setDirty(true)
    setSaveError("")
  }

  const handleSave = async () => {
    setSaveError("")
    let fields
    try {
      fields = mediaInfoPatch({
        image: isImage(),
        latitude: latitude(),
        longitude: longitude(),
        dateTaken: dateTaken(),
        make: make(),
        model: model()
      })
    } catch (error) {
      setSaveError(error.message)
      return
    }

    setSaving(true)
    try {
      await props.onSave(fields)
      setDirty(false)
    } catch (err) {
      console.error("[photo-info] Save failed:", err)
      setSaveError(err?.message || "Photo info could not be saved.")
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    const att = props.attachment
    setLatitude(att.latitude != null ? String(att.latitude) : "")
    setLongitude(att.longitude != null ? String(att.longitude) : "")
    setDateTaken(
      toDatetimeLocalValue(
        att.created_at || att.exif_data?.DateTimeOriginal || ""
      )
    )
    setMake(att.exif_data?.Make || "")
    setModel(att.exif_data?.Model || "")
    setDirty(false)
    setSaveError("")
  }

  // --- Mini-map ---
  const initMap = async (container, lat, lon) => {
    const { maplibregl, layers, namedFlavor } = await loadMapLibs()

    mapProtocol ||= acquireMapProtocol(maplibregl, api)

    mapInstance = new maplibregl.Map({
      container,
      style: {
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
        layers: layers("protomaps", namedFlavor("dark"), {
          lang: "en"
        })
      },
      center: [lon, lat],
      zoom: 12,
      interactive: false,
      attributionControl: false
    })

    new maplibregl.Marker().setLngLat([lon, lat]).addTo(mapInstance)
  }

  // Initialize/update map when GPS data is available
  createEffect(
    on(
      () => [props.attachment?.latitude, props.attachment?.longitude],
      ([lat, lon]) => {
        if (mapInstance) {
          mapInstance.remove()
          mapInstance = null
        }
        if (lat != null && lon != null && mapContainer) {
          initMap(mapContainer, lat, lon)
        }
      }
    )
  )

  onCleanup(() => {
    if (mapInstance) {
      mapInstance.remove()
      mapInstance = null
    }
    mapProtocol?.release()
    mapProtocol = null
  })

  const formatSize = (bytes) => {
    if (!bytes) return null
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return (
    <div class="photo-info-panel" onClick={(e) => e.stopPropagation()}>
      <div class="photo-info-panel__header">
        <h3 class="photo-info-panel__title">Media Info</h3>
        <button
          class="photo-info-panel__close"
          aria-label="Close panel"
          onClick={props.onClose}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      <Show
        when={
          isImage() &&
          props.attachment?.latitude != null &&
          props.attachment?.longitude != null
        }
      >
        <div class="photo-info-panel__map" ref={mapContainer} />
      </Show>

      <div class="photo-info-panel__fields">
        <label class="photo-info-panel__label">
          File name
          <input
            class="photo-info-panel__input"
            value={props.attachment?.file_name || ""}
            readOnly
          />
        </label>

        <Show when={props.attachment?.file_path}>
          <label class="photo-info-panel__label">
            File path
            <input
              class="photo-info-panel__input"
              value={props.attachment.file_path}
              readOnly
              title={props.attachment.file_path}
            />
          </label>
        </Show>

        <Show when={isImage()}>
          <div class="photo-info-panel__row">
            <label class="photo-info-panel__label">
              Latitude
              <input
                class="photo-info-panel__input"
                type="number"
                step="any"
                value={latitude()}
                onInput={setField(setLatitude)}
              />
            </label>
            <label class="photo-info-panel__label">
              Longitude
              <input
                class="photo-info-panel__input"
                type="number"
                step="any"
                value={longitude()}
                onInput={setField(setLongitude)}
              />
            </label>
          </div>
        </Show>

        <div class="photo-info-panel__label">
          Date taken
          <div class="photo-info-panel__row">
            <CompactDatePicker
              value={datePart(dateTaken())}
              onChange={setDatePart}
              renderTrigger={({ ref, onClick, ariaExpanded, disabled }) => (
                <button
                  ref={ref}
                  type="button"
                  class="photo-info-panel__input photo-info-panel__picker-btn"
                  aria-label="Edit date taken date"
                  aria-expanded={ariaExpanded}
                  disabled={disabled || saving()}
                  onClick={onClick}
                >
                  {datePart(dateTaken())
                    ? formatDate(datePart(dateTaken()))
                    : "No date"}
                </button>
              )}
            />
            <CompactTimePicker
              value={timePart(dateTaken())}
              onChange={setTimePart}
              disabled={saving() || !datePart(dateTaken())}
              step={1}
              includeSeconds
              renderTrigger={({ ref, onClick, ariaExpanded, disabled }) => (
                <button
                  ref={ref}
                  type="button"
                  class="photo-info-panel__input photo-info-panel__picker-btn"
                  aria-label="Edit date taken time"
                  aria-expanded={ariaExpanded}
                  disabled={disabled}
                  onClick={onClick}
                >
                  {timePart(dateTaken()) || "--:--:--"}
                </button>
              )}
            />
          </div>
        </div>

        <Show when={isImage()}>
          <div class="photo-info-panel__row">
            <label class="photo-info-panel__label">
              Make
              <input
                class="photo-info-panel__input"
                value={make()}
                onInput={setField(setMake)}
              />
            </label>
            <label class="photo-info-panel__label">
              Model
              <input
                class="photo-info-panel__input"
                value={model()}
                onInput={setField(setModel)}
              />
            </label>
          </div>
        </Show>

        <Show when={props.attachment}>
          <div class="photo-info-panel__meta">
            <span>Type: {props.attachment.mime_type}</span>
            <Show when={props.attachment.byte_size}>
              <span>Size: {formatSize(props.attachment.byte_size)}</span>
            </Show>
          </div>
        </Show>
      </div>

      <Show when={saveError()}>
        <div class="message-form__errors" role="alert">
          {saveError()}
        </div>
      </Show>

      <div class="photo-info-panel__actions">
        <button
          class="btn btn--ghost btn--sm"
          onClick={handleCancel}
          disabled={!dirty() || saving()}
        >
          Cancel
        </button>
        <button
          class="btn btn--primary btn--sm"
          onClick={handleSave}
          disabled={!dirty() || saving()}
        >
          {saving() ? "Saving\u2026" : "Save"}
        </button>
      </div>
    </div>
  )
}
