import { useLightbox } from "../../hooks/useLightbox.js"

/**
 * Create lightbox navigation state and helpers for an index-based lightbox.
 * @param {() => Array} items - Accessor for the items array
 * @returns {{ index, open, close, prev, next, current }}
 */
export function createLightboxNav(items) {
  const lightbox = useLightbox(items)

  return {
    index: lightbox.currentIndex,
    open: lightbox.openByIndex,
    close: lightbox.close,
    prev: lightbox.prev,
    next: lightbox.next,
    current: lightbox.currentItem
  }
}

/**
 * Navigate to the timeline view for a given day.
 *
 * Looks up the day by date if no dayId is provided, creating it via
 * ensureDay() as a last resort. Then selects the day and switches to
 * the timeline view.
 */
export async function goToTimeline({
  dayDate,
  dayId,
  state,
  api,
  selectDay,
  setView
}) {
  let resolvedDayId = dayId
  if (!resolvedDayId) {
    const day = state.days.find((d) => d.date === dayDate)
    if (day) {
      resolvedDayId = day.id
    } else {
      const d = await api.days.ensure(dayDate)
      resolvedDayId = d.id
    }
  }
  if (resolvedDayId) {
    await selectDay({ id: resolvedDayId, date: dayDate })
    setView("timeline")
  }
}
