import { createMemo, createSignal } from "solid-js"

/**
 * useContextMenu - Shared hook for context menu state management
 * Handles positioning and visibility
 */
export function useContextMenu() {
  const [menu, setMenu] = createSignal(null)

  const isOpen = () => menu() !== null

  const open = (x, y, items) => {
    setMenu({ x, y, items })
  }

  const close = () => {
    setMenu(null)
  }

  const position = createMemo(() => {
    const m = menu()
    if (!m) return { x: 0, y: 0 }
    return { x: m.x, y: m.y }
  })

  const items = createMemo(() => {
    const m = menu()
    if (!m) return []
    return m.items
  })

  return {
    menu,
    isOpen,
    position,
    items,
    open,
    close
  }
}
