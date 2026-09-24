import {
  formatMonthYear,
  monthKeyFromDate
} from "../../../lib/formatters/date-utils.js"
import { stripMarkdown } from "../../../lib/formatters/html-utils.js"

export const YEAR_HEADER_HEIGHT = 56
export const MONTH_HEADER_HEIGHT = 44

export function buildRows(items, columns) {
  const rows = []
  const monthToRow = new Map()
  let currentKey = null
  let currentYear = null
  let currentRow = null

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const key = monthKeyFromDate(item.date)

    if (key && key !== currentKey) {
      if (currentRow) {
        rows.push(currentRow)
        currentRow = null
      }

      const year = key.slice(0, 4)
      if (year !== currentYear) {
        rows.push({ type: "year-header", year })
        currentYear = year
      }

      monthToRow.set(key, rows.length)
      rows.push({ type: "month-header", key, label: formatMonthYear(key) })
      currentKey = key
    }

    // Full-width rows for special card layouts
    if (
      item.type === "duplicate-group" ||
      item.type === "missing-photo" ||
      item.type === "missing-date-photo"
    ) {
      if (currentRow) {
        rows.push(currentRow)
        currentRow = null
      }
      rows.push({ type: "item-row", items: [item], startIndex: i })
      continue
    }

    if (!currentRow) {
      currentRow = { type: "item-row", items: [], startIndex: i }
    }
    currentRow.items.push(item)

    if (currentRow.items.length >= columns) {
      rows.push(currentRow)
      currentRow = null
    }
  }

  if (currentRow) {
    rows.push(currentRow)
  }

  return { rows, monthToRow }
}

export function getPhotoCaption(data) {
  if (!data.message_content) return null
  const text = stripMarkdown(data.message_content)
  return text.length > 120 ? text.slice(0, 120) + "..." : text
}
