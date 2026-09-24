import { For, onCleanup, onMount, Show } from "solid-js"

export function ContextMenu(props) {
  let menuRef

  onMount(() => {
    const handleClick = (e) => {
      if (menuRef && !menuRef.contains(e.target)) {
        props.onClose?.()
      }
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

  const style = () => {
    const x = Math.min(props.x, window.innerWidth - 220)
    const y = Math.min(props.y, window.innerHeight - 200)
    return { left: `${x}px`, top: `${y}px` }
  }

  return (
    <div class="context-menu" ref={menuRef} style={style()}>
      <For each={props.items}>
        {(item) => (
          <Show
            when={!item.separator}
            fallback={<div class="context-menu__separator" />}
          >
            <button
              class="context-menu__item"
              classList={{
                "context-menu__item--active": item.active,
                "context-menu__item--danger": item.danger
              }}
              onClick={() => {
                item.action?.()
                props.onClose?.()
              }}
            >
              <Show when={item.icon}>
                <span class="context-menu__icon">{item.icon}</span>
              </Show>
              <span class="context-menu__label">{item.label}</span>
              <Show when={item.active}>
                <span class="context-menu__check">&#10003;</span>
              </Show>
            </button>
          </Show>
        )}
      </For>
    </div>
  )
}
