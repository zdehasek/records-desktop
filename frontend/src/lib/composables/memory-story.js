import { useApp } from "../../context/AppContext.jsx"
import { createSignal } from "solid-js"

export function createMemoryStory() {
  const { loadMemoryStoryItems } = useApp()
  const [items, setItems] = createSignal([])
  const [open, setOpen] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [message, setMessage] = createSignal("")

  const play = async (event) => {
    event?.stopPropagation?.()
    if (loading()) return false
    setLoading(true)
    setMessage("")
    try {
      const nextItems = await loadMemoryStoryItems()
      if (!nextItems.length) {
        setMessage("No important memories to play yet.")
        return false
      }
      setItems(nextItems)
      setOpen(true)
      return true
    } catch (error) {
      console.error("[memory-stories] Failed to load:", error)
      setMessage("Could not load memories story.")
      return false
    } finally {
      setLoading(false)
    }
  }

  return {
    items,
    open,
    loading,
    message,
    play,
    close: () => setOpen(false)
  }
}
