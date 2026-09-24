import { StoryPlayer } from "../../components/common/StoryPlayer.jsx"
import { useApp } from "../../context/AppContext.jsx"
import { createMemoryStory } from "../../lib/composables/memory-story.js"
import { createEffect, For, on, Show } from "solid-js"

function memoryDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric"
  })
}

export default function OnThisDay() {
  const {
    state,
    selectDay,
    getThumbnailUrl,
    getAttachmentUrl,
    handleThumbnailError,
    memoryStoryRequestTick
  } = useApp()
  const story = createMemoryStory()
  const memories = () => [...state.memoryDays].reverse()

  createEffect(
    on(memoryStoryRequestTick, (tick) => {
      if (tick > 0) story.play()
    })
  )

  return (
    <section class="on-this-day" aria-labelledby="on-this-day-title">
      <div class="on-this-day__intro">
        <span class="on-this-day__eyebrow">Your memories</span>
        <h1 id="on-this-day-title">On This Day</h1>
        <p>See what happened around this day in the past.</p>
        <Show when={state.memoryDays.length > 0}>
          <button
            type="button"
            class="on-this-day__play"
            onClick={story.play}
            disabled={story.loading()}
          >
            <span aria-hidden="true">▶</span>
            {story.loading() ? "Preparing memories..." : "Play memories"}
          </button>
        </Show>
        <Show when={story.message()}>
          <p class="on-this-day__status" role="status">
            {story.message()}
          </p>
        </Show>
      </div>

      <Show when={state.memoryDays.length > 0}>
        <div class="on-this-day__grid">
          <For each={memories()}>
            {(day) => (
              <button
                type="button"
                class="on-this-day__card"
                classList={{
                  "on-this-day__card--photo": !!day.photo_attachment_id
                }}
                onClick={() => selectDay(day)}
                aria-label={`${day.label}, ${memoryDate(day.date)}`}
              >
                <Show when={day.photo_attachment_id}>
                  <img
                    src={getThumbnailUrl(day.photo_attachment_id)}
                    alt=""
                    loading="eager"
                    onError={(event) =>
                      handleThumbnailError(
                        day.photo_attachment_id,
                        event.currentTarget
                      )
                    }
                  />
                </Show>
                <span class="on-this-day__card-shade" />
                <span class="on-this-day__period">{day.label}</span>
                <span class="on-this-day__date">{memoryDate(day.date)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={state.memoryLoading && state.memoryDays.length === 0}>
        <p class="on-this-day__loading">Looking through your memories...</p>
      </Show>

      <Show when={!state.memoryLoading && state.memoryDays.length === 0}>
        <div class="on-this-day__empty">
          <span aria-hidden="true">◇</span>
          <h2>No memories for today yet</h2>
          <p>
            When past entries line up with this date, they will appear here.
          </p>
        </div>
      </Show>

      <Show when={state.memoryLoading && state.memoryDays.length > 0}>
        <p class="on-this-day__refreshing" role="status">
          Updating memories...
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
    </section>
  )
}
