import { useApp } from "../../../context/AppContext.jsx"
import { useApi } from "../../../context/PlatformContext.jsx"
import { createSignal, Show } from "solid-js"

export function PhotoButton() {
  const { state, refreshMessages, refreshDays, loadAllPhotos, loadGeoPhotos } =
    useApp()
  const api = useApi()
  const [adding, setAdding] = createSignal(false)
  const [error, setError] = createSignal("")

  const addPhoto = async () => {
    if (!state.currentDayId || adding()) return
    setAdding(true)
    setError("")
    try {
      const result = await api.attachments.pickAndAdd(state.currentDayId)
      if (!result) return
      await Promise.all([
        refreshMessages(),
        refreshDays({ preserveSelection: true }),
        loadAllPhotos(),
        loadGeoPhotos()
      ])
    } catch (err) {
      console.error("[photo] Failed to add:", err)
      setError(err.message || "Could not add photo or video")
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
      <button
        type="button"
        class="day-section__icon-btn"
        classList={{ "day-section__icon-btn--busy": adding() }}
        aria-label="Add photo or video"
        title="Add photo or video"
        onClick={addPhoto}
        disabled={adding()}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
          <rect
            x="3"
            y="5"
            width="18"
            height="14"
            rx="2"
            stroke="currentColor"
            stroke-width="2"
          />
          <circle cx="8.5" cy="10" r="1.5" fill="currentColor" />
          <path
            d="M21 16l-5.2-5.2a1.4 1.4 0 00-2 0L5 19"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <Show when={error()}>
        <span class="day-section__add-error" role="alert">
          {error()}
        </span>
      </Show>
    </>
  )
}
