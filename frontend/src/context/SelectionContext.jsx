import { createSimpleContext } from "../lib/create-context.jsx"
import { useApp } from "./AppContext.jsx"
import { createEffect, createSignal, on, onCleanup } from "solid-js"

const SelectionCtx = createSimpleContext("Selection")
export const useSelection = SelectionCtx.use

export function SelectionWrapper(props) {
  const { state } = useApp()
  const [selecting, setSelecting] = createSignal(false)
  const [selectedIds, setSelectedIds] = createSignal(new Set())

  const toggle = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectMany = (ids) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    setSelecting(true)
  }

  const clear = () => {
    setSelectedIds(new Set())
    setSelecting(false)
  }

  const isSelected = (id) => selectedIds().has(id)
  const count = () => selectedIds().size

  // Clear selection when view or day changes
  createEffect(on(() => state.view, clear, { defer: true }))
  createEffect(on(() => state.currentDayId, clear, { defer: true }))

  // Escape key exits selection mode
  const handleKeyDown = (e) => {
    if (e.key === "Escape" && selecting()) {
      e.preventDefault()
      clear()
    }
  }
  window.addEventListener("keydown", handleKeyDown)
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown))

  return (
    <SelectionCtx.Provider
      value={{
        selecting,
        setSelecting,
        selectedIds,
        toggle,
        selectMany,
        clear,
        isSelected,
        count
      }}
    >
      {props.children}
    </SelectionCtx.Provider>
  )
}
