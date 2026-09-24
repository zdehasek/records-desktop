import { useApi } from "../../context/PlatformContext.jsx"
import { formatDate } from "../../lib/formatters/date-utils.js"
import {
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show
} from "solid-js"
import { Portal } from "solid-js/web"

const STILL_DURATION = 4000

function itemTitle(item) {
  if (item.attachment?.file_name) return item.attachment.file_name
  return "Memory"
}

function itemKind(item) {
  const mime = item.attachment?.mime_type || ""
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("video/")) return "video"
  return null
}

export function StoryPlayer(props) {
  const api = useApi()
  const [index, setIndex] = createSignal(props.initialIndex || 0)
  const [paused, setPaused] = createSignal(false)
  const [progress, setProgress] = createSignal(0)
  const [videoUrl, setVideoUrl] = createSignal(null)
  let timer = null
  let startedAt = 0
  let elapsedBeforePause = 0
  let rootRef

  const items = () => props.items || []
  const currentItem = () => items()[index()] || null
  const currentKind = () => (currentItem() ? itemKind(currentItem()) : null)
  const hasPrev = () => index() > 0
  const hasNext = () => index() < items().length - 1

  const clearTimer = () => {
    if (timer) window.clearTimeout(timer)
    timer = null
  }

  const next = () => {
    if (hasNext()) {
      setIndex((value) => value + 1)
    } else {
      props.onClose()
    }
  }

  const prev = () => {
    if (hasPrev()) setIndex((value) => value - 1)
  }

  const startStillTimer = () => {
    clearTimer()
    setProgress(Math.min(elapsedBeforePause / STILL_DURATION, 1))
    if (paused()) return

    startedAt = Date.now()
    const remaining = Math.max(STILL_DURATION - elapsedBeforePause, 0)
    timer = window.setTimeout(next, remaining)
  }

  createEffect(
    on(
      () => index(),
      () => {
        clearTimer()
        elapsedBeforePause = 0
        setProgress(0)
        setPaused(false)
        if (currentKind() !== "video") startStillTimer()
      }
    )
  )

  createEffect(
    on(
      () => paused(),
      (isPaused) => {
        if (currentKind() === "video") return
        if (isPaused) {
          elapsedBeforePause += Date.now() - startedAt
          clearTimer()
        } else {
          startStillTimer()
        }
      },
      { defer: true }
    )
  )

  createEffect(() => {
    if (currentKind() === "video") return
    if (paused()) return
    const frame = window.setInterval(() => {
      const elapsed = elapsedBeforePause + Date.now() - startedAt
      setProgress(Math.min(elapsed / STILL_DURATION, 1))
    }, 100)
    onCleanup(() => window.clearInterval(frame))
  })

  createEffect(
    on(
      () => [
        currentItem()?.attachment?.id,
        currentItem()?.attachment?.mime_type
      ],
      async ([id, mime]) => {
        if (!id || !mime?.startsWith("video/")) {
          setVideoUrl(null)
          return
        }
        try {
          setVideoUrl(await api.attachments.streamableUrl(id))
        } catch {
          setVideoUrl(null)
        }
      }
    )
  )

  const handleKeyDown = (event) => {
    if (event.key === "Escape") props.onClose()
    if (event.key === "ArrowLeft") prev()
    if (event.key === "ArrowRight") next()
    if (event.key === " ") {
      event.preventDefault()
      setPaused((value) => !value)
    }
  }

  onCleanup(() => {
    clearTimer()
  })

  onMount(() => rootRef?.focus())

  return (
    <Portal>
      <div
        ref={rootRef}
        class="story-player"
        tabIndex="-1"
        onKeyDown={handleKeyDown}
      >
        <div class="story-player__progress" aria-hidden="true">
          <For each={items()}>
            {(_, i) => (
              <div class="story-player__bar">
                <span
                  style={{
                    transform: `scaleX(${i() < index() ? 1 : i() === index() ? progress() : 0})`
                  }}
                />
              </div>
            )}
          </For>
        </div>

        <button
          type="button"
          class="story-player__close"
          onClick={props.onClose}
          aria-label="Close stories"
        >
          ×
        </button>

        <button
          type="button"
          class="story-player__zone story-player__zone--prev"
          onClick={prev}
          disabled={!hasPrev()}
          aria-label="Previous story"
        />
        <button
          type="button"
          class="story-player__zone story-player__zone--next"
          onClick={next}
          aria-label="Next story"
        />

        <Show when={currentItem()}>
          {(item) => (
            <div class="story-player__frame">
              <div class="story-player__meta">
                <span>{item().day.label}</span>
                <span>{formatDate(item().day.date)}</span>
                <Show when={item().isCover}>
                  <span class="story-player__meta-first">1</span>
                </Show>
                <Show when={item().isImportant}>
                  <span class="story-player__meta-important">
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      stroke="currentColor"
                      stroke-width="2"
                    >
                      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
                    </svg>
                  </span>
                </Show>
              </div>

              <Show
                when={currentKind() === "image"}
                fallback={
                  <Show when={currentKind() === "video"}>
                    <video
                      class="story-player__media"
                      src={
                        videoUrl() ||
                        props.getAttachmentUrl(item().attachment.id)
                      }
                      autoplay
                      playsinline
                      controls={false}
                      muted={false}
                      onTimeUpdate={(event) => {
                        const video = event.currentTarget
                        if (video.duration) {
                          setProgress(video.currentTime / video.duration)
                        }
                      }}
                      onEnded={next}
                    />
                  </Show>
                }
              >
                <img
                  class="story-player__media"
                  src={props.getAttachmentUrl(item().attachment.id)}
                  alt={itemTitle(item())}
                />
              </Show>

              <div class="story-player__caption">{itemTitle(item())}</div>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  )
}
