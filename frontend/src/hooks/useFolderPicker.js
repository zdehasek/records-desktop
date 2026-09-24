import { createMemo, createSignal } from "solid-js"

/**
 * useFolderPicker - Shared hook for folder picker state management
 */
export function useFolderPicker() {
  const [picker, setPicker] = createSignal(null)

  const isOpen = () => picker() !== null

  const position = createMemo(() => {
    const p = picker()
    if (!p) return { x: 0, y: 0 }
    return { x: p.x, y: p.y }
  })

  const messageId = createMemo(() => {
    const p = picker()
    return p?.messageId || null
  })

  const currentVisibility = createMemo(() => {
    const p = picker()
    return p?.currentVisibility || "visible"
  })

  const open = (x, y, messageId, currentVisibility) => {
    setPicker({ x, y, messageId, currentVisibility })
  }

  const close = () => {
    setPicker(null)
  }

  return {
    picker,
    isOpen,
    position,
    messageId,
    currentVisibility,
    open,
    close
  }
}
