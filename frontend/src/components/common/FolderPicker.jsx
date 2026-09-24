import {
  isDotFolder,
  isUserFolder
} from "../../lib/formatters/visibility-utils.js"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"

export function FolderPicker(props) {
  let ref
  const [inputValue, setInputValue] = createSignal("")

  const visibleFolders = () => {
    if (props.dotFilesVisible) return props.folders.filter(isUserFolder)
    return props.folders.filter((f) => isUserFolder(f) && !isDotFolder(f))
  }

  const style = () => {
    const x = Math.min(props.x, window.innerWidth - 220)
    const y = Math.min(props.y, window.innerHeight - 300)
    return { left: `${x}px`, top: `${y}px` }
  }

  onMount(() => {
    const handleClick = (e) => {
      if (ref && !ref.contains(e.target)) props.onClose?.()
    }
    const handleKey = (e) => {
      if (e.key === "Escape") props.onClose?.()
    }
    document.addEventListener("mousedown", handleClick)
    document.addEventListener("keydown", handleKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", handleClick)
      document.removeEventListener("keydown", handleKey)
    })
  })

  const handleSubmit = () => {
    const name = inputValue().trim()
    if (name) {
      props.onSelect(name)
      props.onClose?.()
    }
  }

  return (
    <div class="folder-picker" ref={ref} style={style()}>
      <div class="folder-picker__title">Move to NSFW</div>
      <For each={visibleFolders()}>
        {(folder) => (
          <button
            class="folder-picker__item"
            classList={{
              "folder-picker__item--active": props.currentVisibility === folder,
              "folder-picker__item--dot": isDotFolder(folder)
            }}
            onClick={() => {
              props.onSelect(folder)
              props.onClose?.()
            }}
          >
            <span class="folder-picker__name">{folder}</span>
            <Show when={props.currentVisibility === folder}>
              <span class="folder-picker__check">&#10003;</span>
            </Show>
          </button>
        )}
      </For>
      <div class="folder-picker__separator" />
      <div class="folder-picker__input-row">
        <input
          class="folder-picker__input"
          placeholder="New folder..."
          value={inputValue()}
          onInput={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit()
            if (e.key === "Escape") props.onClose?.()
          }}
          autofocus
        />
      </div>
    </div>
  )
}
