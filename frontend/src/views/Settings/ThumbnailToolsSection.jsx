import { Show } from "solid-js"

const thumbnailPercent = (progress) =>
  Math.min(
    99,
    Math.floor(((progress?.done ?? 0) / (progress?.total ?? 1)) * 100)
  )

export function ThumbnailToolsSection(props) {
  return (
    <div class="settings-view__card">
      <label class="settings-panel__section-title">Thumbnail Cache</label>
      <div class="settings-panel__field">
        <button
          class="btn btn--sm"
          disabled={
            props.thumbnailRebuildRunning() || Boolean(props.thumbWarmup())
          }
          onClick={props.handleRegenerateAllThumbnails}
        >
          {props.thumbnailRebuildRunning()
            ? "Regenerating..."
            : props.thumbWarmup()
              ? "Caching thumbnails..."
              : "Regenerate thumbnails"}
        </button>
        <span class="settings-panel__hint">
          Rebuild photo thumbnails from originals when cache quality looks off.
        </span>
        <Show when={props.thumbWarmup()}>
          <div
            class="thumbnail-cache__progress"
            role="progressbar"
            aria-label="Caching thumbnails"
            aria-valuemin="0"
            aria-valuemax={props.thumbWarmup().total}
            aria-valuenow={props.thumbWarmup().done}
          >
            <div
              class="thumbnail-cache__progress-fill"
              style={{ width: `${thumbnailPercent(props.thumbWarmup())}%` }}
            />
          </div>
          <span class="settings-panel__hint">
            {props.thumbWarmup().done.toLocaleString()} /{" "}
            {props.thumbWarmup().total.toLocaleString()} thumbnails ·{" "}
            {thumbnailPercent(props.thumbWarmup())}%
          </span>
        </Show>
      </div>
    </div>
  )
}
