import { useApp } from "../../../context/AppContext.jsx"
import { formatDate } from "../../../lib/formatters/date-utils.js"
import { For, Show } from "solid-js"

export function DuplicateGroupCard(props) {
  // props: item (type "duplicate-group") with backend-computed members
  const { getThumbnailUrl, handleThumbnailError } = useApp()

  return (
    <div class="records__dup-group">
      <For each={props.item.data.members}>
        {(member) => (
          <div class="records__dup-copy">
            <div class="records__dup-thumb-wrap">
              <Show
                when={member.attachmentId != null}
                fallback={<div class="records__dup-thumb" />}
              >
                <img
                  class="records__dup-thumb"
                  src={getThumbnailUrl(member.attachmentId)}
                  alt={member.fileName || "Photo"}
                  loading="lazy"
                  onError={(e) =>
                    handleThumbnailError(member.attachmentId, e.currentTarget)
                  }
                />
                <Show when={member.mimeType?.startsWith("video/")}>
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
            <div class="records__dup-meta">
              <div class="records__dup-badges">
                <Show when={member.isCanonical}>
                  <span class="records__dup-badge records__dup-badge--canonical">
                    Canonical
                  </span>
                </Show>
                <span class="records__dup-badge">Imported</span>
              </div>
              <span class="records__dup-date">
                {formatDate(
                  member.dayDate || props.item.data.members[0]?.dayDate
                )}
              </span>
              <span class="records__dup-path" title={member.filePath}>
                {member.filePath}
              </span>
            </div>
            <div class="records__dup-actions">
              <Show when={member.canSetDefault}>
                <button
                  class="records__dup-default"
                  onClick={() =>
                    props.onSetDefault(
                      props.item.data.checksum,
                      member.attachmentId
                    )
                  }
                >
                  Set default
                </button>
              </Show>
              <button
                class="records__dup-delete"
                disabled={!member.canDelete}
                title={
                  member.canDelete
                    ? "Delete duplicate"
                    : "Canonical cannot be deleted"
                }
                onClick={() => {
                  if (!member.canDelete) return
                  props.onDeleteImported(member.messageId)
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      </For>
    </div>
  )
}
