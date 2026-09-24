import { useApp } from "../../context/AppContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { usePushSubscriptions } from "../../hooks/usePushSubscriptions.js"
import {
  dateToIso,
  formatDayNameShort,
  today
} from "../../lib/formatters/date-utils.js"
import { formatDayNumber } from "../../lib/layout/filmstrip-utils.js"
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js"

const MONTH_NAMES_SHORT = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC"
]

export default function Year() {
  const {
    state,
    selectDay,
    setView,
    setYearViewYear,
    settings,
    nsfwMode,
    dotFilesVisible,
    contentRefreshTick,
    handleThumbnailError
  } = useApp()
  const api = useApi()
  const getThumbnailUrl = (id) => `${api.attachments.thumbnailUrl(id)}?v=3`

  const [rangeData, setRangeData] = createSignal([])
  const [refreshTick, setRefreshTick] = createSignal(0)
  const currentYear = () => state.yearViewYear

  const todayIso = () => state.today || today()
  const visOpts = () => ({
    nsfwMode: nsfwMode(),
    dotFilesVisible: dotFilesVisible()
  })

  const dateRange = createMemo(() => {
    const year = currentYear()
    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`
    }
  })

  const yearDays = createMemo(() => {
    const year = currentYear()
    const start = new Date(`${year}-01-01T00:00:00`)
    const end = new Date(`${year}-12-31T00:00:00`)
    const result = []
    const cursor = new Date(start)

    while (cursor <= end) {
      result.push(dateToIso(cursor))
      cursor.setDate(cursor.getDate() + 1)
    }

    return result
  })

  const dataByDate = createMemo(() => {
    const map = new Map()
    for (const d of rangeData()) map.set(d.date, d)
    return map
  })

  const appDaysByDate = createMemo(() => {
    const map = new Map()
    for (const d of state.days) {
      if (d?.date) map.set(d.date, d)
    }
    for (const d of state.memoryDays) {
      if (d?.date && !map.has(d.date)) map.set(d.date, d)
    }
    return map
  })

  createEffect(
    on(
      [
        dateRange,
        refreshTick,
        settings,
        nsfwMode,
        dotFilesVisible,
        contentRefreshTick
      ],
      async ([range]) => {
        if (!range) return
        try {
          const days = await api.days.listForRange(range.start, range.end, {
            ...visOpts(),
            autoPhoto: settings().auto_photo_in_week_overview === "true"
          })
          setRangeData(days || [])
        } catch (err) {
          console.error("[Year] fetchRange error:", err)
        }
      }
    )
  )

  usePushSubscriptions([
    [api.on.photosImported, () => setRefreshTick((n) => n + 1)]
  ])

  const goToPrevYear = () => {
    setYearViewYear(currentYear() - 1)
  }

  const goToNextYear = () => {
    setYearViewYear(currentYear() + 1)
  }

  const goToCurrentYear = () => {
    setYearViewYear(Number(todayIso().slice(0, 4)))
  }

  const handleDayClick = async (date) => {
    if (!date) return
    try {
      const existing = appDaysByDate().get(date) || dataByDate().get(date)
      if (existing) {
        selectDay(existing)
        return
      }

      const day = await api.days.ensure(date)
      if (day?.id && day?.date) {
        selectDay(day)
      } else {
        setView("timeline")
      }
    } catch (err) {
      console.error("[Year] handleDayClick error:", err)
      setView("timeline")
    }
  }

  const isFirstOfMonth = (date) => {
    const d = new Date(date + "T00:00:00")
    return d.getDate() === 1
  }

  const getMonthShort = (date) => {
    const d = new Date(date + "T00:00:00")
    return MONTH_NAMES_SHORT[d.getMonth()]
  }

  return (
    <div class="year-view">
      <div class="year-view__header">
        <button class="year-view__today-btn" onClick={goToCurrentYear}>
          Today
        </button>
      </div>

      <div class="year-view__nav">
        <button class="year-view__nav-btn" onClick={goToPrevYear}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span class="year-view__year-label">{currentYear()}</span>
        <button class="year-view__nav-btn" onClick={goToNextYear}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>

      <div class="year-view__calendar">
        <div class="year-view__grid">
          <For each={yearDays()}>
            {(date) => {
              const data = () => dataByDate().get(date)
              const isToday = () => date === todayIso()
              const photoId = () => data()?.photo_attachment_id
              const hasPhotos = () => data()?.photo_count > 0 && !photoId()
              const dayObj = new Date(date + "T00:00:00")
              const isWeekend = () => {
                const day = dayObj.getDay()
                return day === 0 || day === 6
              }

              return (
                <button
                  class={`year-view__cell${isToday() ? " year-view__cell--today" : ""}${photoId() ? " year-view__cell--has-photo" : ""}${isWeekend() ? " year-view__cell--weekend" : ""}`}
                  onClick={() => handleDayClick(date)}
                >
                  <Show when={photoId()}>
                    <img
                      class="year-view__photo"
                      src={getThumbnailUrl(photoId())}
                      alt=""
                      loading="lazy"
                      onError={(event) =>
                        handleThumbnailError(photoId(), event.currentTarget)
                      }
                    />
                  </Show>
                  <div class="year-view__cell-content">
                    <Show when={isFirstOfMonth(date)}>
                      <span class="year-view__month-indicator">
                        {getMonthShort(date)} {formatDayNumber(date)}
                      </span>
                    </Show>
                    <Show when={!isFirstOfMonth(date)}>
                      <span class="year-view__day-indicator">
                        {formatDayNameShort(date)} {formatDayNumber(date)}
                      </span>
                    </Show>
                    <div class="year-view__dots">
                      <Show when={hasPhotos()}>
                        <span class="year-view__dot year-view__dot--photo" />
                      </Show>
                    </div>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
