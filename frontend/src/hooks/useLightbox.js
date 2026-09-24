import { createMemo, createSignal } from "solid-js"

/**
 * useLightbox - Shared hook for photo lightbox state management
 * Handles navigation, counters, and index tracking
 *
 * @param {Function} items - Signal or memo returning array of items
 * @param {Object} options - Configuration options
 * @param {Function} options.getId - Function to extract ID from item (item => item.id)
 * @param {Function} options.formatCounter - Optional custom counter formatter (index, total) => string
 */
export function useLightbox(items, options = {}) {
  const [currentId, setCurrentId] = createSignal(null)

  const isOpen = () => currentId() !== null

  const currentIndex = createMemo(() => {
    const id = currentId()
    if (id == null) return -1
    return items().findIndex((item) => {
      const itemId = options.getId ? options.getId(item) : item.id
      return itemId === id
    })
  })

  const currentItem = createMemo(() => {
    const idx = currentIndex()
    if (idx < 0) return null
    return items()[idx]
  })

  const counterText = createMemo(() => {
    const idx = currentIndex()
    const total = items().length
    if (idx < 0 || total === 0) return ""
    if (options.formatCounter) {
      return options.formatCounter(idx, total)
    }
    return `${idx + 1} / ${total}`
  })

  const hasPrev = createMemo(() => currentIndex() > 0)

  const hasNext = createMemo(() => {
    const idx = currentIndex()
    return idx >= 0 && idx < items().length - 1
  })

  const open = (id) => setCurrentId(id)
  const openByIndex = (index) => {
    const item = items()[index]
    if (!item) return
    setCurrentId(options.getId ? options.getId(item) : item.id)
  }
  const close = () => setCurrentId(null)

  const prev = () => {
    const idx = currentIndex()
    if (idx > 0) {
      const item = items()[idx - 1]
      setCurrentId(options.getId ? options.getId(item) : item.id)
    }
  }

  const next = () => {
    const idx = currentIndex()
    const itemsList = items()
    if (idx < itemsList.length - 1) {
      const item = itemsList[idx + 1]
      setCurrentId(options.getId ? options.getId(item) : item.id)
    }
  }

  return {
    currentId,
    currentIndex,
    currentItem,
    isOpen,
    counterText,
    hasPrev,
    hasNext,
    open,
    openByIndex,
    close,
    prev,
    next
  }
}
