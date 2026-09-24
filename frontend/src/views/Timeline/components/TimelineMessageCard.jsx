import { formatTime } from "../../../lib/formatters/date-utils.js"
import { stripMarkdown } from "../../../lib/formatters/html-utils.js"
import {
  isDotFolder,
  isNsfw
} from "../../../lib/formatters/visibility-utils.js"
import { InstaxNote } from "./InstaxNote.jsx"
import { StickyNoteColorPicker } from "../../../components/common/StickyNoteCard.jsx"
import { getStickyNoteColor } from "../../../lib/sticky-notes.js"
import { getAttachmentPhotoDate } from "../lib/media-sort.js"
import { createSignal, For, onCleanup, Show } from "solid-js"

const SHARE_CARD_WIDTH = 900
const SHARE_CARD_HEIGHT = 1230
const SHARE_CARD_PADDING = 44
const SHARE_PHOTO_SIZE = SHARE_CARD_WIDTH - SHARE_CARD_PADDING * 2
const SHARE_ATTRIBUTION = "https://myrecords.app/"

function formatPhotoAge(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "today"
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days < 1) return "today"
  if (days < 60) return `${days} ${days === 1 ? "day" : "days"} ago`
  const months = Math.floor(days / 30)
  if (months < 24) {
    return `${months} ${months === 1 ? "month" : "months"} ago`
  }
  const years = Math.floor(days / 365)
  return `${years} ${years === 1 ? "year" : "years"} ago`
}

function formatMemoryAge(label) {
  const match = String(label || "").match(/^(\d+)([MY])$/)
  if (!match) return null
  const count = Number(match[1])
  const unit = match[2] === "Y" ? "year" : "month"
  return count ? `${count} ${unit}${count === 1 ? "" : "s"} ago` : null
}

function formatShareDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return "Date unknown"
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric"
  })
}

function wrapCanvasText(ctx, text, maxWidth, maxLines) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  const lines = []
  let line = ""
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (ctx.measureText(next).width <= maxWidth) {
      line = next
    } else {
      if (line) lines.push(line)
      line = word
      if (lines.length === maxLines) break
    }
  }
  if (line && lines.length < maxLines) lines.push(line)
  if (
    lines.length === maxLines &&
    lines.join(" ").length < words.join(" ").length
  ) {
    const index = lines.length - 1
    while (
      ctx.measureText(`${lines[index]}...`).width > maxWidth &&
      lines[index].length > 1
    ) {
      lines[index] = lines[index].slice(0, -1)
    }
    lines[index] += "..."
  }
  return lines
}

function loadShareImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Could not load photo"))
    image.src = src
  })
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error("Could not create share image"))
    }, "image/png")
  })
}

async function drawShareImage({ image, age, date, note }) {
  const canvas = document.createElement("canvas")
  canvas.width = SHARE_CARD_WIDTH
  canvas.height = SHARE_CARD_HEIGHT
  const ctx = canvas.getContext("2d")
  ctx.fillStyle = "#f7f4ed"
  ctx.fillRect(0, 0, SHARE_CARD_WIDTH, SHARE_CARD_HEIGHT)
  ctx.fillStyle = "#e7e1d5"
  ctx.fillRect(
    SHARE_CARD_PADDING - 2,
    SHARE_CARD_PADDING - 2,
    SHARE_PHOTO_SIZE + 4,
    SHARE_PHOTO_SIZE + 4
  )
  const scale = Math.max(
    SHARE_PHOTO_SIZE / image.naturalWidth,
    SHARE_PHOTO_SIZE / image.naturalHeight
  )
  const width = SHARE_PHOTO_SIZE / scale
  const height = SHARE_PHOTO_SIZE / scale
  ctx.drawImage(
    image,
    (image.naturalWidth - width) / 2,
    (image.naturalHeight - height) / 2,
    width,
    height,
    SHARE_CARD_PADDING,
    SHARE_CARD_PADDING,
    SHARE_PHOTO_SIZE,
    SHARE_PHOTO_SIZE
  )
  const textLeft = SHARE_CARD_PADDING + 8
  const textWidth = SHARE_CARD_WIDTH - textLeft * 2
  ctx.textAlign = "left"
  ctx.fillStyle = "#4d473f"
  ctx.font = "italic 44px Georgia, serif"
  const lines = wrapCanvasText(ctx, stripMarkdown(note || ""), textWidth, 2)
  lines.forEach((line, index) => ctx.fillText(line, textLeft, 935 + index * 54))
  ctx.textAlign = "center"
  ctx.fillStyle = "#4f493f"
  ctx.font = "500 34px system-ui, sans-serif"
  ctx.fillText(
    formatShareDate(date),
    SHARE_CARD_WIDTH / 2,
    lines.length ? 1060 : 970
  )
  ctx.fillStyle = "#2d2923"
  ctx.font = "700 58px system-ui, sans-serif"
  ctx.fillText(
    age || formatPhotoAge(date),
    SHARE_CARD_WIDTH / 2,
    lines.length ? 1130 : 1040
  )
  ctx.fillStyle = "#746d61"
  ctx.font = "500 28px system-ui, sans-serif"
  ctx.fillText(SHARE_ATTRIBUTION, SHARE_CARD_WIDTH / 2, 1190)
  return canvasToPngBlob(canvas)
}

function ShareInstaxButton(props) {
  const [status, setStatus] = createSignal("idle")
  let resetTimer
  onCleanup(() => clearTimeout(resetTimer))
  const title = () => {
    if (status() === "copying") return "Copying share image"
    if (status() === "copied") return "Copied share image"
    if (status() === "error") return "Could not copy share image"
    return "Copy share image"
  }
  const copy = async (event) => {
    event.stopPropagation()
    if (status() === "copying") return
    try {
      setStatus("copying")
      const image = await loadShareImage(props.src)
      const blob = await drawShareImage({
        image,
        age: props.age,
        date: props.date,
        note: props.note
      })
      if (!navigator.clipboard?.write || !window.ClipboardItem) {
        throw new Error("Image clipboard is not supported")
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob })
      ])
      setStatus("copied")
    } catch (error) {
      console.error("[share instax]", error)
      setStatus("error")
    } finally {
      clearTimeout(resetTimer)
      resetTimer = setTimeout(() => setStatus("idle"), 1800)
    }
  }
  return (
    <button
      type="button"
      class="message__instax-share"
      classList={{
        "message__instax-share--copying": status() === "copying",
        "message__instax-share--copied": status() === "copied",
        "message__instax-share--error": status() === "error"
      }}
      onClick={copy}
      title={title()}
      aria-label={title()}
      disabled={status() === "copying"}
    >
      <Show
        when={status() === "copied"}
        fallback={
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
            <path d="M16 6l-4-4-4 4" />
            <path d="M12 2v13" />
          </svg>
        }
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      </Show>
    </button>
  )
}

function ImportantButton(props) {
  return (
    <button
      type="button"
      class="message__instax-important"
      classList={{ "message__instax-important--active": props.active }}
      onClick={(event) => {
        event.stopPropagation()
        props.onToggle()
      }}
      title={props.active ? "Unmark important" : "Mark important"}
      aria-label={props.active ? "Unmark important" : "Mark important"}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill={props.active ? "currentColor" : "none"}
        stroke="currentColor"
        stroke-width="2"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  )
}

export function TimelineMessageCard(props) {
  const blurred = () =>
    isNsfw(props.msg.visibility) &&
    props.blurNsfw &&
    props.revealedId !== props.msg.id

  return (
    <article
      class="message message--calendar message--media message--timeline-photo"
      classList={{
        "message--nsfw": isNsfw(props.msg.visibility),
        "message--dotfolder": isDotFolder(props.msg.visibility),
        "message--blurred": blurred(),
        "message--selecting": props.selecting
      }}
      onClick={() => props.selecting && props.onToggleSelect()}
      onContextMenu={props.onContextMenu}
    >
      <For each={props.attachments}>
        {(attachment) => {
          const isVideo = attachment.mime_type?.startsWith("video/")
          const isShareablePhoto =
            attachment.mime_type?.startsWith("image/") &&
            attachment.mime_type !== "image/gif"
          const photoDate = () =>
            getAttachmentPhotoDate(attachment) || props.msg.created_at
          const memoryDay = () => props.currentDay?.()
          return (
            <div
              class={`message__instax message__instax--${getStickyNoteColor(props.msg.metadata)}`}
            >
              <div
                class="message__instax-media"
                onClick={(event) => {
                  if (props.selecting || blurred()) return
                  event.stopPropagation()
                  props.onOpenLightbox(attachment.id)
                }}
              >
                <img
                  src={props.getThumbnailUrl(attachment.id)}
                  alt={attachment.file_name || (isVideo ? "Video" : "Photo")}
                  class="message__instax-image"
                  loading="lazy"
                  onError={(event) =>
                    props.onThumbnailError(attachment.id, event.currentTarget)
                  }
                />
                <Show when={isVideo}>
                  <div class="message__instax-play">
                    <svg
                      width="40"
                      height="40"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                </Show>
                <div class="message__instax-time">
                  {formatTime(props.msg.created_at)}
                </div>
                <ImportantButton
                  active={Boolean(props.msg.metadata?.important)}
                  onToggle={props.onToggleImportant}
                />
                <Show when={isShareablePhoto}>
                  <ShareInstaxButton
                    src={props.getAttachmentUrl(attachment.id).split("?")[0]}
                    date={memoryDay()?.date || photoDate()}
                    age={formatMemoryAge(memoryDay()?.label)}
                    note={props.msg.content}
                  />
                </Show>
              </div>
              <InstaxNote
                messageId={props.msg.id}
                content={props.msg.content}
              />
              <StickyNoteColorPicker
                color={getStickyNoteColor(props.msg.metadata)}
                onChange={props.onUpdateNoteColor}
              />
            </div>
          )
        }}
      </For>

      <Show when={props.selecting}>
        <div
          class="select-check"
          classList={{ "select-check--active": props.isSelected }}
        >
          <svg
            viewBox="0 0 24 24"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
      </Show>

      <Show when={isNsfw(props.msg.visibility) && props.blurNsfw}>
        <div
          class="nsfw-overlay"
          classList={{
            "nsfw-overlay--revealed": props.revealedId === props.msg.id
          }}
          onClick={(event) => {
            if (props.revealedId === props.msg.id) return
            event.stopPropagation()
            props.onReveal()
          }}
        >
          <Show
            when={props.revealedId === props.msg.id}
            fallback={
              <>
                <span class="nsfw-overlay__label">{props.msg.visibility}</span>
                <span class="nsfw-overlay__hint">Click to reveal</span>
              </>
            }
          >
            <button
              type="button"
              class="nsfw-overlay__hide"
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                props.onHideReveal()
              }}
            >
              Hide
            </button>
          </Show>
        </div>
      </Show>
    </article>
  )
}
