import { useApp } from "../../context/AppContext.jsx"
import { useApi } from "../../context/PlatformContext.jsx"
import { usePushSubscriptions } from "../../hooks/usePushSubscriptions.js"
import {
  dateToIso,
  formatDayNameShort,
  today
} from "../../lib/formatters/date-utils.js"
import {
  buildWeekDates,
  formatDayNumber,
  getWeekStartNum,
  isoWeekNumber,
  monthLabel
} from "../../lib/layout/filmstrip-utils.js"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show
} from "solid-js"

const INITIAL_PAST_WEEKS = 4
const INITIAL_FUTURE_WEEKS = 3
const LOAD_MORE_WEEKS = 4

export default function Week() {
  const {
    state,
    selectDay,
    setView,
    goToToday,
    settings,
    nsfwMode,
    dotFilesVisible,
    contentRefreshTick,
    handleThumbnailError
  } = useApp()
  const api = useApi()
  const getThumbnailUrl = (id) => `${api.attachments.thumbnailUrl(id)}?v=3`

  const [rangeData, setRangeData] = createSignal([])
  const [attachments, setAttachments] = createSignal([])
  const [loadedRange, setLoadedRange] = createSignal({
    pastWeeks: INITIAL_PAST_WEEKS,
    futureWeeks: INITIAL_FUTURE_WEEKS
  })
  const [showFullView, setShowFullView] = createSignal(false)
  const [refreshTick, setRefreshTick] = createSignal(0)

  let scrollRef
  let refreshTimer = null
  let initialSimplePositioned = false
  let initialFullPositioned = false

  function scrollCurrentWeek(mode, options = {}) {
    const { allowExpandPast = false } = options
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scrollRef) return
        const currentWeek = scrollRef.querySelector(
          mode === "full"
            ? ".week-view__week-row--current"
            : ".week-view__simple-row--current"
        )
        if (!currentWeek) return

        const weekHeight = currentWeek.offsetHeight || 1
        const desiredTop = Math.max(
          16,
          scrollRef.clientHeight - weekHeight + (mode === "full" ? 35 : 0)
        )

        if (allowExpandPast) {
          const missingSpace = desiredTop - currentWeek.offsetTop
          if (missingSpace > 0) {
            const extraWeeks = Math.max(1, Math.ceil(missingSpace / weekHeight))
            setLoadedRange((range) => ({
              ...range,
              pastWeeks: range.pastWeeks + extraWeeks
            }))
            return
          }
        }

        const maxScroll = Math.max(
          0,
          scrollRef.scrollHeight - scrollRef.clientHeight
        )
        scrollRef.scrollTop = Math.min(
          maxScroll,
          Math.max(0, currentWeek.offsetTop - desiredTop)
        )

        if (allowExpandPast && mode === "full") {
          initialFullPositioned = true
        }

        if (allowExpandPast && mode !== "full") {
          initialSimplePositioned = true
        }
      })
    })
  }

  const visOpts = () => ({
    nsfwMode: nsfwMode(),
    dotFilesVisible: dotFilesVisible()
  })

  const weekStartDay = () => getWeekStartNum(settings())
  const todayIso = () => state.today || today()
  const currentYear = () => new Date().getFullYear()

  // Build week rows
  const weekRows = createMemo(() => {
    const { pastWeeks, futureWeeks } = loadedRange()
    const ws = weekStartDay()
    const today = todayIso()
    if (!today) return []

    const rows = []
    for (let i = -pastWeeks; i <= futureWeeks; i++) {
      const anchor = new Date(today + "T12:00:00")
      if (isNaN(anchor.getTime())) continue
      anchor.setDate(anchor.getDate() + i * 7)
      const dates = buildWeekDates(dateToIso(anchor), ws)
      if (dates.length === 7) {
        rows.push({ weekOffset: i, dates })
      }
    }
    return rows
  })

  // Date range for fetching
  const dateRange = createMemo(() => {
    const rows = weekRows()
    if (rows.length === 0) return null
    return { start: rows[0].dates[0], end: rows[rows.length - 1].dates[6] }
  })

  // Data lookups
  const dataByDate = createMemo(() => {
    const map = new Map()
    for (const d of rangeData()) if (d?.date) map.set(d.date, d)
    return map
  })

  const photosByDate = createMemo(() => {
    const map = new Map()
    for (const att of attachments()) {
      if (
        !att?.day_date ||
        (!att.mime_type?.startsWith("image/") &&
          !att.mime_type?.startsWith("video/"))
      )
        continue
      const date = att.day_date
      if (!map.has(date)) map.set(date, [])
      map.get(date).push(att)
    }
    // Sort by created_at
    for (const [, photos] of map) {
      photos.sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    }
    return map
  })

  // Pre-compute data presence for each week (eager evaluation - no lazy delays)
  const weekHasData = createMemo(() => {
    const result = new Map()
    for (const week of weekRows()) {
      const dates = week.dates
      let hasPhotos = false

      for (const date of dates) {
        const dayPhotos = photosByDate().get(date)
        if (dayPhotos && dayPhotos.length > 0) hasPhotos = true
      }

      result.set(week.weekOffset, {
        hasPhotos
      })
    }
    return result
  })

  let fetchVersion = 0

  async function fetchRangeData(range) {
    if (!range?.start || !range?.end) return
    const version = ++fetchVersion
    try {
      const [days, attach] = await Promise.all([
        api.days.listForRange(range.start, range.end, {
          ...visOpts(),
          autoPhoto: settings().auto_photo_in_week_overview === "true"
        }),
        api.attachments.listForRange(range.start, range.end, visOpts())
      ])
      if (version !== fetchVersion) return
      setRangeData(days || [])
      setAttachments(attach || [])
    } catch (err) {
      if (version !== fetchVersion) return
      console.error("[Week] fetchRange error:", err)
    }
  }

  const requestRefresh = () => {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      setRefreshTick((n) => n + 1)
    }, 120)
  }

  usePushSubscriptions([[api.on.photosImported, requestRefresh]])

  // Fetch data when range changes or push events request refresh
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
      ([range]) => {
        fetchRangeData(range)
      }
    )
  )

  // Scroll to current week
  onMount(() => {
    setTimeout(() => scrollCurrentWeek(showFullView() ? "full" : "simple"), 150)
    setupInfiniteScroll()
    onCleanup(() => clearTimeout(refreshTimer))
  })

  createEffect(
    on(
      () => weekRows().length,
      () => {
        if (!showFullView() && !initialSimplePositioned) {
          scrollCurrentWeek("simple", { allowExpandPast: true })
        }

        if (showFullView() && !initialFullPositioned) {
          scrollCurrentWeek("full", { allowExpandPast: true })
        }
      },
      { defer: true }
    )
  )

  createEffect(
    on(
      showFullView,
      (full) => {
        if (full) {
          initialFullPositioned = false
        } else {
          initialSimplePositioned = false
        }
        scrollCurrentWeek(full ? "full" : "simple")
      },
      { defer: true }
    )
  )

  let loading = false
  function setupInfiniteScroll() {
    if (!scrollRef) return
    const topSentinel = scrollRef.querySelector(".week-view__sentinel--top")
    const bottomSentinel = scrollRef.querySelector(
      ".week-view__sentinel--bottom"
    )
    if (!topSentinel || !bottomSentinel) return

    const topObs = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || loading) return
        loading = true
        const prevHeight = scrollRef.scrollHeight
        const prevScroll = scrollRef.scrollTop
        setLoadedRange((r) => ({
          ...r,
          pastWeeks: r.pastWeeks + LOAD_MORE_WEEKS
        }))
        requestAnimationFrame(() => {
          scrollRef.scrollTop =
            prevScroll + (scrollRef.scrollHeight - prevHeight)
          loading = false
        })
      },
      { root: scrollRef, threshold: 0 }
    )

    const bottomObs = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || loading) return
        loading = true
        setLoadedRange((r) => ({
          ...r,
          futureWeeks: r.futureWeeks + LOAD_MORE_WEEKS
        }))
        loading = false
      },
      { root: scrollRef, threshold: 0 }
    )

    topObs.observe(topSentinel)
    bottomObs.observe(bottomSentinel)
    onCleanup(() => {
      topObs.disconnect()
      bottomObs.disconnect()
    })
  }

  function shouldShowMonthSeparator(weekIdx) {
    const rows = weekRows()
    if (weekIdx === 0) return true
    if (!rows[weekIdx - 1]?.dates?.[0] || !rows[weekIdx]?.dates?.[0])
      return false
    const prevMonth = new Date(
      rows[weekIdx - 1].dates[0] + "T00:00:00"
    ).getMonth()
    const thisMonth = new Date(rows[weekIdx].dates[0] + "T00:00:00").getMonth()
    return thisMonth !== prevMonth
  }

  function getMonthSeparatorLabel(week) {
    if (!week?.dates?.length) return ""
    const firstOfMonth = week.dates.find((d) => {
      try {
        return new Date(d + "T00:00:00").getDate() === 1
      } catch {
        return false
      }
    })
    return monthLabel(firstOfMonth || week.dates[0], currentYear())
  }

  const handleDayClick = async (date) => {
    if (!date) return
    try {
      const existing = dataByDate().get(date)
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
      console.error("[Week] handleDayClick error:", err)
      setView("timeline")
    }
  }

  const isToday = (date) => date && date === todayIso()

  return (
    <div class="week-view">
      <div class="week-view__header">
        <button
          class="week-view__toggle-btn"
          onClick={() => setShowFullView((v) => !v)}
          title={showFullView() ? "Show simple view" : "Show full view"}
        >
          {showFullView() ? "Simple" : "Full"}
        </button>
        <button class="week-view__today-btn" onClick={goToToday}>
          Today
        </button>
      </div>

      <div class="week-view__scroll" ref={scrollRef}>
        <div class="week-view__sentinel week-view__sentinel--top" />

        <For each={weekRows()}>
          {(week, idx) => {
            const weekNum = isoWeekNumber(week.dates?.[3] || week.dates?.[0])

            const hasPhotos = () =>
              weekHasData().get(week.weekOffset)?.hasPhotos === true

            return (
              <>
                <Show when={shouldShowMonthSeparator(idx())}>
                  <div class="week-view__month-separator">
                    <span class="week-view__month-separator-label">
                      {getMonthSeparatorLabel(week)}
                    </span>
                  </div>
                </Show>

                <Show when={!showFullView()}>
                  {/* Simple photo-only view like ExpandedWeekPanel */}
                  <div
                    class={`week-view__simple-row${week.weekOffset === 0 ? " week-view__simple-row--current" : ""}`}
                  >
                    <span class="week-view__simple-label">W{weekNum}</span>
                    <div class="week-view__simple-cells">
                      <For each={week.dates}>
                        {(date) => {
                          const day = () => dataByDate().get(date)
                          const photoId = () => day()?.photo_attachment_id
                          const hasPhotos = () =>
                            day()?.photo_count > 0 && !photoId()
                          return (
                            <button
                              class={`week-view__simple-cell${isToday(date) ? " week-view__simple-cell--today" : ""}${photoId() ? " week-view__simple-cell--has-photo" : ""}`}
                              onClick={() => handleDayClick(date)}
                            >
                              <Show when={photoId()}>
                                <img
                                  class="week-view__simple-photo"
                                  src={getThumbnailUrl(photoId())}
                                  alt=""
                                  loading="lazy"
                                  onError={(event) =>
                                    handleThumbnailError(
                                      photoId(),
                                      event.currentTarget
                                    )
                                  }
                                />
                              </Show>
                              <span class="week-view__simple-day-name">
                                {formatDayNameShort(date)}
                              </span>
                              <span class="week-view__simple-day-num">
                                {formatDayNumber(date)}
                              </span>
                              <div class="week-view__simple-dots">
                                <Show when={hasPhotos()}>
                                  <span class="week-view__simple-dot week-view__simple-dot--photo" />
                                </Show>
                              </div>
                            </button>
                          )
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={showFullView()}>
                  {/* Full detailed view */}
                  <div
                    class={`week-view__week-row${week.weekOffset === 0 ? " week-view__week-row--current" : ""}`}
                  >
                    {/* Week header with 8 columns (week label + 7 days) */}
                    <div class="week-view__week-header">
                      <div class="week-view__week-label">W{weekNum}</div>
                      <For each={week.dates}>
                        {(date) => {
                          const day = () => dataByDate().get(date)
                          const photoId = () => day()?.photo_attachment_id
                          const hasPhotos = () =>
                            day()?.photo_count > 0 && !photoId()

                          return (
                            <button
                              class={`week-view__day-header${isToday(date) ? " week-view__day-header--today" : ""}${photoId() ? " week-view__day-header--has-photo" : ""}`}
                              onClick={() => handleDayClick(date)}
                            >
                              <Show when={photoId()}>
                                <img
                                  class="week-view__day-photo"
                                  src={getThumbnailUrl(photoId())}
                                  alt=""
                                  loading="lazy"
                                  onError={(event) =>
                                    handleThumbnailError(
                                      photoId(),
                                      event.currentTarget
                                    )
                                  }
                                />
                              </Show>
                              <div class="week-view__day-info">
                                <span class="week-view__day-name">
                                  {formatDayNameShort(date)}
                                </span>
                                <span class="week-view__day-num">
                                  {formatDayNumber(date)}
                                </span>
                                <div class="week-view__simple-dots">
                                  <Show when={hasPhotos()}>
                                    <span class="week-view__simple-dot week-view__simple-dot--photo" />
                                  </Show>
                                </div>
                              </div>
                            </button>
                          )
                        }}
                      </For>
                    </div>

                    {/* All photos at bottom - only show if has photos */}
                    {hasPhotos() && (
                      <div class="week-view__photos-section">
                        <div class="week-view__photos-label">
                          Photos and videos
                        </div>
                        <div class="week-view__photos-grid">
                          <div class="week-view__week-label" />
                          <For each={week.dates}>
                            {(date) => {
                              const dayPhotos = () =>
                                photosByDate().get(date) || []
                              return (
                                <div class="week-view__photos-column">
                                  <For each={dayPhotos()}>
                                    {(photo) => (
                                      <div class="week-view__photo-thumb">
                                        <img
                                          src={getThumbnailUrl(photo.id)}
                                          alt=""
                                          loading="lazy"
                                          onError={(event) =>
                                            handleThumbnailError(
                                              photo.id,
                                              event.currentTarget
                                            )
                                          }
                                        />
                                      </div>
                                    )}
                                  </For>
                                </div>
                              )
                            }}
                          </For>
                        </div>
                      </div>
                    )}
                  </div>
                </Show>
              </>
            )
          }}
        </For>

        <div class="week-view__sentinel week-view__sentinel--bottom" />
      </div>
    </div>
  )
}
