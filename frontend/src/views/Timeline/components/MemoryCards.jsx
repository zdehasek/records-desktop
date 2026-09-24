import { useApp } from "../../../context/AppContext.jsx"
import { StoryPlayer } from "../../../components/common/StoryPlayer.jsx"
import { createMemoryStory } from "../../../lib/composables/memory-story.js"
import { createSignal, For, Show } from "solid-js"

function shortDate(dateStr) {
  if (!dateStr) return ""
  const d = new Date(dateStr + "T00:00:00")
  const mon = d.toLocaleString("en", { month: "short" }).toUpperCase()
  const day = d.getDate()
  return `${mon} ${day}`
}

export function MemoryCards() {
  const {
    state,
    selectDay,
    goToToday,
    todayIso,
    getAttachmentUrl,
    getThumbnailUrl,
    handleThumbnailError
  } = useApp()
  const [expanded, setExpanded] = createSignal(true)
  const story = createMemoryStory()

  const isToday = () => state.selectedDate === todayIso()
  const hasMemories = () => state.memoryDays.length > 0
  const isMemoryDate = () =>
    state.memoryDays.some((d) => d.date === state.selectedDate)
  const sortedMemories = () => [...state.memoryDays].reverse()

  const todayPhotoId = () => {
    const todayDay = state.days.find((d) => d.date === todayIso())
    return todayDay?.photo_attachment_id || null
  }

  return (
    <Show when={(isToday() || isMemoryDate()) && hasMemories()}>
      <div class="memory-cards">
        <div class="memory-cards__header">
          <button
            type="button"
            class="memory-cards__play"
            onClick={story.play}
            disabled={story.loading()}
            title="Play memories"
            aria-label="Play memories"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            <span>Play memories</span>
          </button>
          <div class="memory-cards__header-actions">
            <button
              type="button"
              class="memory-cards__toggle"
              onClick={() => setExpanded((v) => !v)}
              aria-label={expanded() ? "Collapse memories" : "Expand memories"}
            >
              <svg
                class="memory-cards__chevron"
                classList={{ "memory-cards__chevron--collapsed": !expanded() }}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.5"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          </div>
        </div>

        <Show when={expanded()}>
          <div
            class="memory-cards__list"
            ref={(el) =>
              requestAnimationFrame(() => (el.scrollLeft = el.scrollWidth))
            }
          >
            <For each={sortedMemories()}>
              {(day) => (
                <button
                  class="memory-cards__card"
                  classList={{
                    "memory-cards__card--has-photo": !!day.photo_attachment_id,
                    "memory-cards__card--active":
                      day.date === state.selectedDate
                  }}
                  onClick={() => selectDay(day)}
                >
                  <Show when={day.photo_attachment_id}>
                    <img
                      class="memory-cards__card-photo"
                      src={getThumbnailUrl(day.photo_attachment_id)}
                      alt=""
                      loading="lazy"
                      onError={(event) =>
                        handleThumbnailError(
                          day.photo_attachment_id,
                          event.currentTarget
                        )
                      }
                    />
                  </Show>
                  <span class="memory-cards__card-name">{day.label}</span>
                  <span class="memory-cards__card-label">
                    {shortDate(day.date)}
                  </span>
                </button>
              )}
            </For>

            <button
              class="memory-cards__card memory-cards__card--today"
              classList={{
                "memory-cards__card--has-photo": !!todayPhotoId(),
                "memory-cards__card--active": isToday()
              }}
              onClick={() => goToToday()}
            >
              <Show when={todayPhotoId()}>
                <img
                  class="memory-cards__card-photo"
                  src={getThumbnailUrl(todayPhotoId())}
                  alt=""
                  loading="lazy"
                  onError={(event) =>
                    handleThumbnailError(todayPhotoId(), event.currentTarget)
                  }
                />
              </Show>
              <span class="memory-cards__card-name">Today</span>
              <span class="memory-cards__card-label">
                {shortDate(todayIso())}
              </span>
            </button>
          </div>
        </Show>
        <Show when={story.message()}>
          <p class="memory-cards__message" role="status">
            {story.message()}
          </p>
        </Show>
        <Show when={story.open()}>
          <StoryPlayer
            items={story.items()}
            getAttachmentUrl={getAttachmentUrl}
            getThumbnailUrl={getThumbnailUrl}
            onClose={story.close}
          />
        </Show>
      </div>
    </Show>
  )
}
