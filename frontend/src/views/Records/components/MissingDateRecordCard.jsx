import { useApp } from "../../../context/AppContext.jsx"
import { formatDate } from "../../../lib/formatters/date-utils.js"
import { Show } from "solid-js"

export function MissingDateRecordCard(props) {
  const { getThumbnailUrl, handleThumbnailError } = useApp()

  return (
    <div
      class="records__missing-card"
      onClick={() => props.onOpen?.(props.item.data.attachmentId)}
    >
      <div class="records__missing-thumb-wrap">
        <Show
          when={props.item.data.attachmentId != null}
          fallback={<div class="records__missing-thumb" />}
        >
          <img
            class="records__missing-thumb"
            src={getThumbnailUrl(props.item.data.attachmentId)}
            alt={props.item.data.fileName || "Photo"}
            loading="lazy"
            onError={(e) =>
              handleThumbnailError(
                props.item.data.attachmentId,
                e.currentTarget
              )
            }
          />
          <Show when={props.item.data.mimeType?.startsWith("video/")}>
            <div class="records__play-icon">
              <svg
                width="28"
                height="28"
                viewBox="0 0 24 24"
                fill="white"
                opacity="0.9"
              >
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </Show>
        </Show>
      </div>
      <div class="records__missing-meta">
        <span class="records__missing-date">{formatDate(props.item.date)}</span>
        <Show when={props.item.data.messageName}>
          <span class="records__missing-name">
            {props.item.data.messageName}
          </span>
        </Show>
        <span class="records__missing-path" title={props.item.data.filePath}>
          {props.item.data.filePath}
        </span>
      </div>
    </div>
  )
}
