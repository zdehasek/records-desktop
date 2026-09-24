import { useApp } from "../context/AppContext.jsx"
import { onCleanup, onMount, Show } from "solid-js"

const progressPercent = (progress) =>
  Math.min(
    99,
    Math.floor(((progress?.done ?? 0) / (progress?.total ?? 1)) * 100)
  )

const photoImportEta = (progress) => {
  const workDone = progress.workDone ?? progress.done - progress.startedDone
  const workTotal = progress.workTotal ?? progress.total - progress.startedDone
  const remaining = Math.max(0, workTotal - workDone)
  const elapsedSeconds = (Date.now() - progress.startedAt) / 1000

  if (workDone < 2 || elapsedSeconds < 2) {
    return "Estimating time remaining..."
  }

  const remainingMinutes = Math.ceil(
    (remaining * (elapsedSeconds / workDone)) / 60
  )
  if (remainingMinutes <= 1) return "Less than a minute remaining."
  if (remainingMinutes < 60) {
    return `About ${remainingMinutes} minutes remaining.`
  }

  const remainingHours = Math.ceil(remainingMinutes / 60)
  return `About ${remainingHours} ${remainingHours === 1 ? "hour" : "hours"} remaining.`
}

export function TopBar(props) {
  const { state, goBack, canGoBack, setView } = useApp()
  const activeProgress = () => state.photoImport || state.thumbWarmup
  const indexingMedia = () => Boolean(state.photoImport)

  const dayLabel = () => {
    if (state.view === "onThisDay") return "On This Day"
    const d = new Date(state.selectedDate + "T00:00:00")
    return d.toLocaleDateString("en-US", {
      weekday: "long",
      day: "numeric",
      month: "long"
    })
  }

  const handleKeydown = (e) => {
    // Don't intercept when typing in inputs
    const tag = e.target.tagName
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      e.target.isContentEditable
    )
      return

    // Ctrl+, or Cmd+, to toggle settings
    if ((e.ctrlKey || e.metaKey) && e.key === ",") {
      e.preventDefault()
      if (state.view === "settings") {
        goBack()
      } else {
        setView("settings")
      }
      return
    }
  }

  onMount(() => {
    document.addEventListener("keydown", handleKeydown)
  })
  onCleanup(() => {
    document.removeEventListener("keydown", handleKeydown)
  })

  return (
    <div class="top-bar" classList={{ "top-bar--hidden": props.hidden }}>
      <div class="top-bar__left">
        <Show when={canGoBack()}>
          <button
            type="button"
            class="top-bar__back-btn"
            aria-label="Go back"
            title="Go back (Alt+Left)"
            onClick={goBack}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        </Show>
        <span class="top-bar__wordmark" aria-label="Records">
          <span class="top-bar__wordmark-icon" aria-hidden="true" />
          <span class="top-bar__wordmark-text">Records</span>
        </span>
      </div>

      <div class="top-bar__center">
        <span class="top-bar__day-label">{dayLabel()}</span>
      </div>

      <div class="top-bar__right">
        <Show when={activeProgress()?.total > 0}>
          <div class="top-bar__import-status" role="status" aria-live="polite">
            <span class="top-bar__import-label">
              {indexingMedia()
                ? `Indexing ${state.photoImport.rootName || "media"}`
                : "Caching thumbnails"}{" "}
              · {progressPercent(activeProgress())}%
            </span>
            <div
              class="top-bar__import-indicator"
              role="progressbar"
              aria-label={
                indexingMedia() ? "Indexing media" : "Caching thumbnails"
              }
              aria-valuemin="0"
              aria-valuemax={activeProgress().total}
              aria-valuenow={activeProgress().done}
            >
              <div
                class="top-bar__import-fill"
                style={{ width: `${progressPercent(activeProgress())}%` }}
              />
            </div>
            <div class="top-bar__import-notice">
              <strong>
                {indexingMedia() ? "Indexing media" : "Caching thumbnails"} ·{" "}
                {activeProgress().done} of {activeProgress().total}
              </strong>
              <span>
                {indexingMedia()
                  ? `${state.photoImport.rootPath ? `${state.photoImport.rootPath} · ${state.photoImport.rootDone} of ${state.photoImport.rootTotal}. ` : ""}Memories will be ready when indexing finishes. ${photoImportEta(state.photoImport)}`
                  : "Photo previews are being cached in the background."}
              </span>
            </div>
          </div>
        </Show>
        <button
          type="button"
          class="top-bar__gear-btn"
          classList={{ "top-bar__gear-btn--active": state.view === "settings" }}
          aria-label="Settings"
          title="Settings (Ctrl+,)"
          onClick={() => {
            if (state.view === "settings") {
              goBack()
            } else {
              setView("settings")
            }
          }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  )
}
