import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show
} from "solid-js"
import { Portal } from "solid-js/web"

import { useApi } from "../../context/PlatformContext.jsx"
import { useContextMenu } from "../../hooks/useContextMenu.js"
import { useFolderPicker } from "../../hooks/useFolderPicker.js"
import { formatCoords } from "../../lib/formatters/location-utils.js"
import { isNsfw } from "../../lib/formatters/visibility-utils.js"
import { buildVisibilityMenuItems } from "../../lib/visibility-menu.js"
import { PhotoInfoPanel } from "../PhotoInfoPanel.jsx"
import { ContextMenuOverlay, FolderPickerOverlay } from "./OverlayMenus.jsx"

const MIN_ZOOM = 1
const MAX_ZOOM = 5
const ZOOM_SENSITIVITY = 0.01

const clampZoom = (value) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))

export function Lightbox(props) {
  const api = useApi()
  const [revealed, setRevealed] = createSignal(false)
  const contextMenu = useContextMenu()
  const folderPicker = useFolderPicker()
  const [showPanel, setShowPanel] = createSignal(false)
  const [attachment, setAttachment] = createSignal(null)
  const [videoUrl, setVideoUrl] = createSignal(null)
  const [videoStatus, setVideoStatus] = createSignal("idle")
  const [videoError, setVideoError] = createSignal(null)
  const [videoRetries, setVideoRetries] = createSignal(0)
  const [zoom, setZoom] = createSignal(MIN_ZOOM)
  const [zoomOrigin, setZoomOrigin] = createSignal("50% 50%")
  let videoPrepareToken = 0

  const isNsfwBlurred = () =>
    isNsfw(props.visibility) && props.blurNsfw && !revealed()
  const messageCoords = () =>
    formatCoords(props.message?.latitude, props.message?.longitude)

  // Fetch full attachment when photoId changes
  createEffect(
    on(
      () => props.photoId,
      async (id) => {
        setZoom(MIN_ZOOM)
        setZoomOrigin("50% 50%")
        setRevealed(false)
        if (!id) {
          setAttachment(null)
          return
        }
        try {
          const att = await api.attachments.get(id)
          setAttachment(att)
        } catch (err) {
          console.error("[lightbox] Failed to load attachment:", err)
          setAttachment(null)
        }
      }
    )
  )

  const withCacheBuster = (url) => {
    const separator = url.includes("?") ? "&" : "?"
    return `${url}${separator}ready=${Date.now()}`
  }

  const prepareVideo = async (id, mime, opts = {}) => {
    const token = ++videoPrepareToken
    if (!id || !mime?.startsWith("video/")) {
      setVideoUrl(null)
      setVideoStatus("idle")
      setVideoError(null)
      return
    }

    setVideoUrl(null)
    setVideoStatus("preparing")
    setVideoError(null)

    try {
      const url = await api.attachments.streamableUrl(id, opts)
      if (token !== videoPrepareToken) return
      if (!url) {
        setVideoStatus("error")
        setVideoError("Video file is missing")
        return
      }
      setVideoUrl(withCacheBuster(url))
      setVideoStatus("ready")
    } catch (err) {
      if (token !== videoPrepareToken) return
      setVideoUrl(null)
      setVideoStatus("error")
      setVideoError(err?.message || "Video could not be prepared")
    }
  }

  // Resolve a browser-compatible stream URL for video playback.
  createEffect(
    on(
      () => [props.photoId, props.mimeType],
      async ([id, mime]) => {
        setVideoRetries(0)
        await prepareVideo(id, mime)
      }
    )
  )

  const handleEscape = () => {
    if (contextMenu.isOpen()) contextMenu.close()
    else if (showPanel()) setShowPanel(false)
    else props.onClose()
  }

  const handleKeyDown = (e) => {
    if (e.key === "Escape") handleEscape()
    if (e.key === "ArrowLeft") props.onPrev()
    if (e.key === "ArrowRight") props.onNext()

    // Guard letter shortcuts against input fields (info panel has inputs)
    const tag = document.activeElement?.tagName
    if (tag === "INPUT" || tag === "TEXTAREA") return
    if (document.activeElement?.contentEditable === "true") return

    if (e.key.toLowerCase() === "i") setShowPanel((prev) => !prev)
    if (e.key === "Delete") props.onDelete?.()
    if (e.key.toLowerCase() === "l") props.onSetLocation?.()
  }

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) props.onClose()
  }

  const handleContextMenu = (e) => {
    if (!props.onVisibilityChange) return
    e.preventDefault()
    const vis = props.visibility || "visible"

    contextMenu.open(
      e.clientX,
      e.clientY,
      buildVisibilityMenuItems({
        visibility: vis,
        onVisible: () => props.onVisibilityChange("visible"),
        onMoveToFolder: () =>
          folderPicker.open(e.clientX, e.clientY, null, vis),
        onDelete: props.onDelete ? () => props.onDelete() : null
      })
    )
  }

  const showInFolder = async () => {
    try {
      await api.attachments.showInFolder(props.photoId)
    } catch (err) {
      console.error("[lightbox] Failed to show attachment in folder:", err)
    }
  }

  const handleWheelZoom = (e) => {
    if (!props.url || props.mimeType?.startsWith("video/")) return
    e.preventDefault()

    const rect = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 100
    const y = ((e.clientY - rect.top) / rect.height) * 100
    setZoomOrigin(`${x}% ${y}%`)

    const nextZoom = clampZoom(zoom() - e.deltaY * ZOOM_SENSITIVITY)
    setZoom(nextZoom)
  }

  const resetZoom = () => {
    setZoom(MIN_ZOOM)
    setZoomOrigin("50% 50%")
  }

  const handleVideoError = async (event) => {
    const message =
      event.currentTarget.error?.message || "Video playback failed"
    if (videoRetries() < 1 && props.photoId) {
      setVideoRetries((count) => count + 1)
      await prepareVideo(props.photoId, props.mimeType, { force: true })
      return
    }
    setVideoStatus("error")
    setVideoError(message)
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeyDown)
    document.body.style.overflow = "hidden"
  })

  onCleanup(() => {
    document.removeEventListener("keydown", handleKeyDown)
    document.body.style.overflow = ""
  })

  return (
    <Portal>
      <div
        class="photos-lightbox is-open"
        classList={{
          "photos-lightbox--panel-open": showPanel()
        }}
        id="photos-lightbox"
        aria-hidden="false"
        onClick={handleBackdropClick}
      >
        <div class="photos-lightbox__content">
          <button
            class="photos-lightbox__close"
            id="lightbox-close"
            aria-label="Close lightbox"
            onClick={props.onClose}
          >
            <svg
              width="24"
              height="24"
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
          <Show when={props.photoId}>
            <button
              class="photos-lightbox__folder-btn"
              aria-label="Show in filesystem"
              onClick={showInFolder}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M3 7.5A2.5 2.5 0 015.5 5H10l2 2h6.5A2.5 2.5 0 0121 9.5v7A2.5 2.5 0 0118.5 19h-13A2.5 2.5 0 013 16.5v-9z"
                />
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9.5 13h5m-2.5-2.5V16"
                />
              </svg>
            </button>
            <button
              class="photos-lightbox__info-btn"
              aria-label="Media info"
              onClick={() => setShowPanel((prev) => !prev)}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4" stroke-linecap="round" />
                <path d="M12 8h.01" stroke-linecap="round" />
              </svg>
            </button>
          </Show>
          <Show when={props.onDelete}>
            <button
              class="photos-lightbox__delete-btn"
              aria-label="Move photo to Trash"
              onClick={() => props.onDelete()}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
          </Show>
          <Show when={props.onSetLocation}>
            <button
              class="photos-lightbox__location-btn"
              aria-label="Set location on map"
              onClick={() => props.onSetLocation()}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
                />
                <circle cx="12" cy="9" r="2.5" />
              </svg>
            </button>
          </Show>
          <Show when={props.hasPrev}>
            <button
              class="photos-lightbox__nav photos-lightbox__nav--prev"
              id="lightbox-prev"
              aria-label="Previous photo"
              onClick={props.onPrev}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M15 19l-7-7 7-7"
                />
              </svg>
            </button>
          </Show>
          <div
            class="photos-lightbox__media-wrap"
            onContextMenu={handleContextMenu}
            onWheel={handleWheelZoom}
            onDblClick={resetZoom}
          >
            <Show
              when={!props.mimeType?.startsWith("video/")}
              fallback={
                <Show
                  when={videoUrl() && videoStatus() !== "preparing"}
                  fallback={
                    <div class="photos-lightbox__video-state">
                      <Show when={videoStatus() !== "error"}>
                        <div class="photos-lightbox__video-spinner" />
                      </Show>
                      <span>
                        {videoStatus() === "error"
                          ? videoError() || "Video could not be prepared"
                          : "Preparing video..."}
                      </span>
                    </div>
                  }
                >
                  <video
                    class="photos-lightbox__video"
                    classList={{
                      "photos-lightbox__video--blurred": isNsfwBlurred()
                    }}
                    src={videoUrl()}
                    controls
                    autoplay
                    preload="metadata"
                    onLoadedMetadata={() => setVideoStatus("ready")}
                    onError={handleVideoError}
                  />
                </Show>
              }
            >
              <img
                class="photos-lightbox__image"
                classList={{
                  "photos-lightbox__image--blurred": isNsfwBlurred(),
                  "photos-lightbox__image--zoomed": zoom() > MIN_ZOOM
                }}
                id="lightbox-image"
                src={props.url}
                alt={props.alt}
                style={{
                  transform: `scale(${zoom()})`,
                  "transform-origin": zoomOrigin()
                }}
              />
            </Show>
            <Show when={isNsfw(props.visibility) && props.blurNsfw}>
              <div
                class="nsfw-overlay nsfw-overlay--lightbox"
                classList={{ "nsfw-overlay--revealed": revealed() }}
                onClick={(e) => {
                  if (revealed()) return
                  e.preventDefault()
                  e.stopPropagation()
                  setRevealed(true)
                }}
              >
                <Show
                  when={revealed()}
                  fallback={
                    <>
                      <span class="nsfw-overlay__label">
                        {props.visibility}
                      </span>
                      <span class="nsfw-overlay__hint">Click to reveal</span>
                    </>
                  }
                >
                  <button
                    type="button"
                    class="nsfw-overlay__hide"
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setRevealed(false)
                    }}
                  >
                    Hide
                  </button>
                </Show>
              </div>
            </Show>
          </div>
          <Show when={props.hasNext}>
            <button
              class="photos-lightbox__nav photos-lightbox__nav--next"
              id="lightbox-next"
              aria-label="Next photo"
              onClick={props.onNext}
            >
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M9 5l7 7-7 7"
                />
              </svg>
            </button>
          </Show>
          <div class="photos-lightbox__info">
            <span class="photos-lightbox__date" id="lightbox-date">
              {props.date}
            </span>
            <Show when={messageCoords()}>
              <span class="photos-lightbox__location">
                <span>{messageCoords()}</span>
              </span>
            </Show>
            <Show when={props.mimeType === "image/gif"}>
              <span class="photos-lightbox__type-badge">GIF</span>
            </Show>
            <span class="photos-lightbox__counter" id="lightbox-counter">
              {props.counter}
            </span>
            <Show when={props.onGoToTimeline}>
              <button
                class="photos-lightbox__go-btn"
                onClick={() => props.onGoToTimeline()}
              >
                Open in Timeline
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
                    d="M13 7l5 5m0 0l-5 5m5-5H6"
                  />
                </svg>
              </button>
            </Show>
          </div>
        </div>

        <Show when={showPanel() && attachment()}>
          <PhotoInfoPanel
            attachment={attachment()}
            onSave={async (fields) => {
              const updated = await api.attachments.update(
                props.photoId,
                fields
              )
              setAttachment(updated)
              await props.onAttachmentUpdated?.(updated)
            }}
            onClose={() => setShowPanel(false)}
          />
        </Show>

        <ContextMenuOverlay state={contextMenu} />
        <FolderPickerOverlay
          state={folderPicker}
          folders={props.folders || []}
          dotFilesVisible={props.dotFilesVisible || false}
          onSelect={(folder) => props.onVisibilityChange(folder)}
        />
      </div>
    </Portal>
  )
}
