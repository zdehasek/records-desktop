import { dateToIso } from "../formatters/date-utils.js"

export function getWeekStartNum(settings) {
  const ws = settings?.week_start_day
  return ws === "sunday" ? 0 : ws === "saturday" ? 6 : 1
}

export function buildWeekDates(anchorIso, weekStartDay) {
  const d = new Date(anchorIso + "T12:00:00")
  const dow = d.getDay()
  const diff = (dow - weekStartDay + 7) % 7
  const start = new Date(d)
  start.setDate(d.getDate() - diff)
  const dates = []
  for (let i = 0; i < 7; i++) {
    const cur = new Date(start)
    cur.setDate(start.getDate() + i)
    dates.push(dateToIso(cur))
  }
  return dates
}

export function formatDayName(date) {
  const d = new Date(date + "T00:00:00")
  return d.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase()
}

export function formatDayNumber(date) {
  return new Date(date + "T00:00:00").getDate()
}

/** ISO 8601 week number */
export function isoWeekNumber(dateStr) {
  const d = new Date(dateStr + "T12:00:00")
  const dayNum = d.getDay() || 7
  d.setDate(d.getDate() + 4 - dayNum)
  const yearStart = new Date(d.getFullYear(), 0, 1)
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

/** Get the month name for a date, with year if not current year */
export function monthLabel(dateStr, currentYear) {
  const d = new Date(dateStr + "T00:00:00")
  const month = d.toLocaleDateString("en-US", { month: "long" })
  const year = d.getFullYear()
  return year === currentYear ? month : `${month} ${year}`
}
