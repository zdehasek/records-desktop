// ==========================================================================
// Month Constants
// ==========================================================================

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
]

// ==========================================================================
// Date Formatting Functions
// ==========================================================================

export const formatDate = (date) => {
  const d =
    typeof date === "string"
      ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00` : date)
      : date
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric"
  })
}

export const formatTime = (dateTime) => {
  const d = typeof dateTime === "string" ? new Date(dateTime) : dateTime
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
}

export const dateToIso = (date) => {
  if (!date || Number.isNaN(date.getTime())) return ""
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

let cachedTestNow

const getTestNow = () => {
  if (cachedTestNow !== undefined) return cachedTestNow
  if (typeof window === "undefined" || !window.location?.search) {
    cachedTestNow = null
    return cachedTestNow
  }

  const raw = new URLSearchParams(window.location.search).get("rec-test-now")
  if (!raw) {
    cachedTestNow = null
    return cachedTestNow
  }

  const parsed = new Date(raw)
  cachedTestNow = Number.isNaN(parsed.getTime()) ? null : parsed
  return cachedTestNow
}

export const today = () => {
  return dateToIso(getTestNow() || new Date())
}

// ==========================================================================
// Month/Year Helpers
// ==========================================================================

/**
 * Extract month key (YYYY-MM) from a date string
 */
export function monthKeyFromDate(dateStr) {
  if (!dateStr) return null
  return dateStr.slice(0, 7)
}

/**
 * Format a month key (YYYY-MM) as "MonthName Year"
 */
export function formatMonthYear(monthKey) {
  if (!monthKey) return ""
  const [year, month] = monthKey.split("-")
  return `${MONTH_NAMES[parseInt(month, 10) - 1]} ${year}`
}

export function formatDayNameShort(dateStr) {
  if (!dateStr) return ""

  const date = new Date(dateStr + "T00:00:00")
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleDateString("en-US", { weekday: "short" })
}
