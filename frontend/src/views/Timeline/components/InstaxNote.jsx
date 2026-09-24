import { useApp } from "../../../context/AppContext.jsx"
import { stripMarkdown } from "../../../lib/formatters/html-utils.js"
import { createSignal, Show } from "solid-js"

export function InstaxNote(props) {
  const { updatePhotoCaption } = useApp()
  const [editing, setEditing] = createSignal(false)
  const [error, setError] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  let inputRef

  const plainText = () => stripMarkdown(props.content || "")

  const autoResizeInput = () => {
    if (!inputRef) return
    inputRef.style.height = "auto"
    inputRef.style.height = `${inputRef.scrollHeight}px`
  }

  const startEditing = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (editing()) return
    setError("")
    setEditing(true)
  }

  const save = async () => {
    if (!inputRef || saving()) return
    const text = inputRef.value.trim()
    const newContent = text || ""
    if (newContent !== (props.content || "")) {
      setSaving(true)
      setError("")
      try {
        await updatePhotoCaption(props.messageId, newContent)
      } catch (err) {
        setError(err.message || "Could not save caption metadata")
        setSaving(false)
        requestAnimationFrame(() => inputRef?.focus())
        return
      }
    }
    setSaving(false)
    setEditing(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      save()
    }
    if (e.key === "Escape") {
      setEditing(false)
    }
  }

  return (
    <div
      class="message__instax-bottom"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={startEditing}
    >
      <Show
        when={editing()}
        fallback={
          <Show
            when={plainText()}
            fallback={
              <span class="message__instax-placeholder">Write a note...</span>
            }
          >
            <span class="message__instax-note">{plainText()}</span>
          </Show>
        }
      >
        <textarea
          ref={(el) => {
            inputRef = el
            requestAnimationFrame(() => {
              el.focus()
              autoResizeInput()
            })
          }}
          class="message__instax-input"
          rows="1"
          value={plainText()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onInput={autoResizeInput}
          onKeyDown={handleKeyDown}
          onBlur={save}
          disabled={saving()}
          maxLength={120}
          placeholder="Write a note..."
        />
        <Show when={error()}>
          <span class="message__instax-error" role="alert">
            {error()}
          </span>
        </Show>
      </Show>
    </div>
  )
}
