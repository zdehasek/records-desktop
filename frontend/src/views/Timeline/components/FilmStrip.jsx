import { CompactDatePicker } from "../../../components/common/CompactDatePicker.jsx"
import { useApp } from "../../../context/AppContext.jsx"
import { useApi } from "../../../context/PlatformContext.jsx"
import { dateToIso } from "../../../lib/formatters/date-utils.js"
import {
  buildWeekDates,
  formatDayName,
  formatDayNumber,
  getWeekStartNum
} from "../../../lib/layout/filmstrip-utils.js"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"

export function FilmStrip() {
  const { state, selectDay, todayIso, settings } = useApp()
  const api = useApi()

  const currentDayNameText = createMemo(() => {
    const date = new Date(state.selectedDate + "T00:00:00")
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      day: "numeric",
      month: "long"
    })
  })

  // The anchor date that determines which week the filmstrip shows
  const [activeAnchor, setActiveAnchor] = createSignal(
    state.selectedDate === todayIso() ? null : state.selectedDate
  )

  const weekStartDay = () => getWeekStartNum(settings())

  // The week currently shown in the collapsed filmstrip
  const weekDates = createMemo(() => {
    const anchor = activeAnchor() || todayIso()
    return buildWeekDates(anchor, weekStartDay())
  })

  // Today's week for comparison
  const todayWeekDates = createMemo(() => {
    return buildWeekDates(todayIso(), weekStartDay())
  })

  // Index days by date for O(1) lookup
  const daysByDate = createMemo(() => {
    const map = {}
    for (const d of state.days) map[d.date] = d
    return map
  })

  // Month/year label for the current week
  const monthLabel = createMemo(() => {
    const dates = weekDates()
    const mid = dates[3] // middle of the week
    const d = new Date(mid + "T00:00:00")
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
  })

  const handleDayClick = async (date) => {
    const existing = daysByDate()[date]
    if (existing) {
      selectDay(existing)
    } else {
      const day = await api.days.ensure(date)
      selectDay(day)
    }
  }

  const handleGoToday = () => {
    setActiveAnchor(null)
    handleDayClick(todayIso())
  }

  const handlePrevWeek = () => {
    const dates = weekDates()
    const first = new Date(dates[0] + "T00:00:00")
    first.setDate(first.getDate() - 7)
    setActiveAnchor(dateToIso(first))
  }

  const handleNextWeek = () => {
    const dates = weekDates()
    const first = new Date(dates[0] + "T00:00:00")
    first.setDate(first.getDate() + 7)
    setActiveAnchor(dateToIso(first))
  }

  const handleDatePick = async (date) => {
    if (!date) return
    setActiveAnchor(date)
    await handleDayClick(date)
  }

  // When currentDayId changes via external navigation (e.g. back button),
  // sync the anchor so the film strip follows the selected day.
  createEffect(
    on(
      () => [state.currentDayId, state.selectedDate],
      () => {
        const current =
          state.days.find((d) => d.id === state.currentDayId) ||
          state.memoryDays.find((d) => d.id === state.currentDayId)
        if (current) {
          const currentWeek = buildWeekDates(current.date, weekStartDay())
          if (!weekDates().includes(current.date)) {
            setActiveAnchor(current.date)
          }
          if (currentWeek[0] === todayWeekDates()[0]) {
            setActiveAnchor(null)
          }
        }
      }
    )
  )

  return (
    <div class="film-strip">
      {/* Month header with week navigation */}
      <div class="film-strip__month-header">
        <button
          class="film-strip__nav-btn"
          onClick={handlePrevWeek}
          aria-label="Previous week"
        >
          <svg
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
              d="M15 19l-7-7 7-7"
            />
          </svg>
        </button>

        <div class="film-strip__month-controls">
          <CompactDatePicker
            value={activeAnchor() || state.selectedDate}
            onChange={handleDatePick}
            ariaLabel="Choose timeline date"
            getDayIndicators={(date) =>
              daysByDate()[date]
                ? ["var(--color-pink-400)", "var(--color-pastel-blue)"]
                : []
            }
            renderTrigger={(trigger) => (
              <button
                ref={trigger.ref}
                class="film-strip__month-label"
                onClick={trigger.onClick}
                aria-haspopup="dialog"
                aria-expanded={trigger.ariaExpanded}
                aria-label="Choose date"
                title="Choose date"
                type="button"
              >
                {monthLabel()}
              </button>
            )}
          />
          <Show when={state.selectedDate !== todayIso()}>
            <button
              class="film-strip__go-today-btn"
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                handleGoToday()
              }}
            >
              Today
            </button>
          </Show>
        </div>

        <button
          class="film-strip__nav-btn"
          onClick={handleNextWeek}
          aria-label="Next week"
        >
          <svg
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
              d="M9 5l7 7-7 7"
            />
          </svg>
        </button>
      </div>

      <div class="film-strip__days">
        <For each={weekDates()}>
          {(date) => {
            const day = () => daysByDate()[date]
            const active = () => day()?.id === state.currentDayId
            const hasContent = () => !!day()
            const isToday = () => date === todayIso()
            return (
              <button
                class="film-strip__day"
                classList={{
                  "film-strip__day--active": active(),
                  "film-strip__day--empty": !hasContent(),
                  "film-strip__day--today": isToday()
                }}
                onClick={() => handleDayClick(date)}
              >
                <span class="film-strip__day-name">{formatDayName(date)}</span>
                <span class="film-strip__day-number">
                  {formatDayNumber(date)}
                </span>
                <Show when={hasContent()}>
                  <span class="film-strip__day-dot" />
                </Show>
                <Show when={isToday()}>
                  <span class="film-strip__today-badge">TODAY</span>
                </Show>
              </button>
            )
          }}
        </For>
      </div>

      <div class="film-strip__day-name-bar">
        <div class="film-strip__day-name-label">
          <span class="film-strip__day-name-text">{currentDayNameText()}</span>
        </div>
      </div>
    </div>
  )
}
