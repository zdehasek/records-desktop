import { STICKY_NOTE_COLORS } from "../../lib/sticky-notes.js"
import { For } from "solid-js"

export function StickyNoteColorPicker(props) {
  const currentColor = () => props.color || "white"
  const selectPointerColor = (event, color) => {
    event.preventDefault()
    event.stopPropagation()
    props.onChange?.(color)
  }
  const selectKeyboardColor = (event, color) => {
    event.preventDefault()
    event.stopPropagation()
    if (event.detail === 0) props.onChange?.(color)
  }

  return (
    <div
      class="sticky-note__palette"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <For each={STICKY_NOTE_COLORS}>
        {(color) => (
          <button
            type="button"
            class="sticky-note__swatch"
            classList={{
              "sticky-note__swatch--active": currentColor() === color.key,
              [`sticky-note__swatch--${color.key}`]: true
            }}
            aria-label={`Set note color to ${color.label.toLowerCase()}`}
            title={color.label}
            onPointerDown={(event) => selectPointerColor(event, color.key)}
            onClick={(event) => selectKeyboardColor(event, color.key)}
          />
        )}
      </For>
    </div>
  )
}
