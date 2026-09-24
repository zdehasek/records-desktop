import { useApp } from "../../../context/AppContext.jsx"
import { useSelection } from "../../../context/SelectionContext.jsx"
import { formatDate } from "../../../lib/formatters/date-utils.js"
import {
  isDotFolder,
  isNsfw
} from "../../../lib/formatters/visibility-utils.js"
import { getPhotoCaption } from "../lib/helpers.js"
import { Show } from "solid-js"

export function RecordCard(props) {
  const { getThumbnailUrl, blurNsfw, handleThumbnailError } = useApp()
  const { selecting, toggle, isSelected } = useSelection()
  const messageId = () => props.item.data.message_id
  const visibility = () => props.item.data.visibility || "visible"
  const blurred = () =>
    isNsfw(visibility()) && blurNsfw() && props.revealedId !== messageId()

  const handleClick = () => {
    if (selecting()) {
      toggle(messageId())
      return
    }
    if (!blurred()) props.onClick()
  }

  return (
    <div
      class="records__item records__item--photo"
      classList={{
        "records__item--selecting": selecting(),
        "records__item--highlight": props.highlightId === props.item.id,
        "records__item--nsfw": isNsfw(visibility()),
        "records__item--dotfolder": isDotFolder(visibility()),
        "records__item--blurred": blurred()
      }}
      onClick={handleClick}
      onContextMenu={(event) => props.onContextMenu?.(event, props.item)}
    >
      <img
        class="records__thumb"
        src={getThumbnailUrl(
          props.item.data.id,
          `${props.item.data.byte_size}-${props.item.data.mtime_ms}`
        )}
        alt={props.item.data.file_name || "Photo or video"}
        loading="lazy"
        onError={(event) =>
          handleThumbnailError(props.item.data.id, event.currentTarget)
        }
      />
      <Show when={props.item.data.mime_type?.startsWith("video/")}>
        <div class="records__play-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </Show>
      <Show when={props.item.data.mime_type === "image/gif"}>
        <div class="records__type-badge">GIF</div>
      </Show>
      <Show when={getPhotoCaption(props.item.data)}>
        <div class="records__name-overlay">
          {getPhotoCaption(props.item.data)}
        </div>
      </Show>
      <div class="records__date-overlay">{formatDate(props.item.date)}</div>

      <Show when={isNsfw(visibility()) && blurNsfw()}>
        <div
          class="nsfw-overlay"
          classList={{
            "nsfw-overlay--revealed": props.revealedId === messageId()
          }}
          onClick={(event) => {
            if (props.revealedId === messageId()) return
            event.preventDefault()
            event.stopPropagation()
            props.onReveal?.(messageId())
          }}
        >
          <Show
            when={props.revealedId === messageId()}
            fallback={
              <>
                <span class="nsfw-overlay__label">{visibility()}</span>
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
                props.onReveal?.(null)
              }}
            >
              Hide
            </button>
          </Show>
        </div>
      </Show>

      <Show when={selecting()}>
        <div
          class="select-check"
          classList={{ "select-check--active": isSelected(messageId()) }}
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
    </div>
  )
}
